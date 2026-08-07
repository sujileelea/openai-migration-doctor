from __future__ import annotations

import importlib.metadata
import json
import platform
import re
import sys
from dataclasses import dataclass
from typing import Any

import libcst as cst
from libcst.metadata import (
    CodePosition,
    MetadataWrapper,
    ParentNodeProvider,
    PositionProvider,
    QualifiedNameProvider,
    QualifiedNameSource,
    ScopeProvider,
)

try:
    import resource
except ImportError:  # Windows has no resource module.
    resource = None  # type: ignore[assignment]


PROTOCOL_VERSION = "1.0.0"
MODEL_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
OPENAI_CLIENT_CONSTRUCTORS = frozenset({"openai.OpenAI", "openai.AsyncOpenAI"})


class RequestError(Exception):
    pass


@dataclass(frozen=True)
class SourceFile:
    path: str
    content: str


@dataclass(frozen=True)
class Match:
    node: cst.SimpleString
    start: CodePosition
    end: CodePosition


def _expect_object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise RequestError(f"{label} must be an object.")
    return value


def _expect_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise RequestError(f"{label} contains unexpected or missing fields.")


def _parse_files(value: object) -> list[SourceFile]:
    if not isinstance(value, list):
        raise RequestError("files must be an array.")
    files: list[SourceFile] = []
    seen_paths: set[str] = set()
    for index, item in enumerate(value):
        record = _expect_object(item, f"files[{index}]")
        _expect_exact_keys(record, {"path", "content"}, f"files[{index}]")
        path = record["path"]
        content = record["content"]
        if not isinstance(path, str) or not path or path in seen_paths:
            raise RequestError(f"files[{index}].path must be a unique non-empty string.")
        if not isinstance(content, str):
            raise RequestError(f"files[{index}].content must be a string.")
        seen_paths.add(path)
        files.append(SourceFile(path=path, content=content))
    return files


def _qualified_import_names(
    visitor: cst.CSTVisitor, node: cst.BaseExpression
) -> set[str]:
    names = visitor.get_metadata(QualifiedNameProvider, node, set())
    return {
        qualified.name
        for qualified in names
        if qualified.source is QualifiedNameSource.IMPORT
    }


def _is_openai_constructor(visitor: cst.CSTVisitor, node: cst.BaseExpression) -> bool:
    return bool(OPENAI_CLIENT_CONSTRUCTORS & _qualified_import_names(visitor, node))


def _attribute_chain(node: cst.BaseExpression) -> tuple[cst.Name, list[str]] | None:
    segments: list[str] = []
    current = node
    while isinstance(current, cst.Attribute):
        segments.append(current.attr.value)
        current = current.value
    if not isinstance(current, cst.Name):
        return None
    return current, [current.value, *reversed(segments)]


class _ClientAssignmentCollector(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (
        ParentNodeProvider,
        PositionProvider,
        QualifiedNameProvider,
    )

    def __init__(self) -> None:
        self.clients: dict[cst.Name, CodePosition] = {}

    def _is_direct_scope_statement(self, node: cst.BaseSmallStatement) -> bool:
        line = self.get_metadata(ParentNodeProvider, node, None)
        if not isinstance(line, cst.SimpleStatementLine):
            return False
        body = self.get_metadata(ParentNodeProvider, line, None)
        if isinstance(body, cst.Module):
            return True
        if not isinstance(body, cst.IndentedBlock):
            return False
        return isinstance(
            self.get_metadata(ParentNodeProvider, body, None), cst.FunctionDef
        )

    def visit_Assign(self, node: cst.Assign) -> None:
        if (
            len(node.targets) == 1
            and self._is_direct_scope_statement(node)
            and isinstance(node.targets[0].target, cst.Name)
            and isinstance(node.value, cst.Call)
            and _is_openai_constructor(self, node.value.func)
        ):
            target = node.targets[0].target
            self.clients[target] = self.get_metadata(PositionProvider, target).start

    def visit_AnnAssign(self, node: cst.AnnAssign) -> None:
        if (
            isinstance(node.target, cst.Name)
            and self._is_direct_scope_statement(node)
            and isinstance(node.value, cst.Call)
            and _is_openai_constructor(self, node.value.func)
        ):
            self.clients[node.target] = self.get_metadata(PositionProvider, node.target).start


class _TranscriptionCallCollector(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider, ScopeProvider)

    def __init__(
        self,
        source_model: str,
        client_assignments: dict[cst.Name, CodePosition],
    ) -> None:
        self.source_model = source_model
        self.client_assignments = client_assignments
        self.matches: list[Match] = []

    def _is_bound_client(self, root: cst.Name, call_position: CodePosition) -> bool:
        scope = self.get_metadata(ScopeProvider, root, None)
        if scope is None:
            return False
        try:
            assignments = list(scope[root.value])
        except KeyError:
            return False
        if len(assignments) != 1:
            return False
        assignment_position = self.client_assignments.get(assignments[0].node)
        if assignment_position is None:
            return False
        return (assignment_position.line, assignment_position.column) < (
            call_position.line,
            call_position.column,
        )

    def visit_Call(self, node: cst.Call) -> None:
        chain = _attribute_chain(node.func)
        if chain is None:
            return
        root, segments = chain
        call_position = self.get_metadata(PositionProvider, node).start
        if segments != [root.value, "audio", "transcriptions", "create"]:
            return
        if not self._is_bound_client(root, call_position):
            return
        if any(argument.star for argument in node.args):
            return

        model_arguments = [
            argument
            for argument in node.args
            if isinstance(argument.keyword, cst.Name) and argument.keyword.value == "model"
        ]
        if len(model_arguments) != 1:
            return
        literal = model_arguments[0].value
        if not isinstance(literal, cst.SimpleString):
            return
        if literal.raw_value != self.source_model or literal.evaluated_value != self.source_model:
            return
        expected_value = f"{literal.prefix}{literal.quote}{self.source_model}{literal.quote}"
        if literal.value != expected_value:
            return

        literal_range = self.get_metadata(PositionProvider, literal)
        content_column = literal_range.start.column + len(literal.prefix) + len(literal.quote)
        start = CodePosition(line=literal_range.start.line, column=content_column)
        end = CodePosition(line=start.line, column=start.column + len(self.source_model))
        self.matches.append(Match(node=literal, start=start, end=end))


class _ModelRewriteTransformer(cst.CSTTransformer):
    def __init__(self, matches: list[Match], target_model: str) -> None:
        self.match_ids = {id(match.node) for match in matches}
        self.target_model = target_model

    def leave_SimpleString(
        self, original_node: cst.SimpleString, updated_node: cst.SimpleString
    ) -> cst.SimpleString:
        if id(original_node) not in self.match_ids:
            return updated_node
        return updated_node.with_changes(
            value=(
                f"{updated_node.prefix}{updated_node.quote}"
                f"{self.target_model}{updated_node.quote}"
            )
        )


def _parse_module(source_file: SourceFile) -> MetadataWrapper:
    try:
        return MetadataWrapper(cst.parse_module(source_file.content))
    except cst.ParserSyntaxError as error:
        line = getattr(error, "raw_line", "unknown")
        column = getattr(error, "raw_column", "unknown")
        raise RequestError(
            f"Unable to parse {source_file.path} at line {line}, column {column}."
        ) from error


def _collect_matches(
    wrapper: MetadataWrapper, source_model: str
) -> list[Match]:
    assignments = _ClientAssignmentCollector()
    wrapper.visit(assignments)
    calls = _TranscriptionCallCollector(source_model, assignments.clients)
    wrapper.visit(calls)
    calls.matches.sort(
        key=lambda match: (
            match.start.line,
            match.start.column,
            match.end.line,
            match.end.column,
        )
    )
    return calls.matches


def _position(position: CodePosition) -> dict[str, int]:
    return {"line": position.line, "column": position.column}


def _restore_lexical_envelope(original: str, transformed: str) -> str:
    content = transformed
    if original.startswith("\ufeff") and not content.startswith("\ufeff"):
        content = f"\ufeff{content}"
    original_newlines = re.search(r"(?:\r\n|\r|\n)+\Z", original)
    transformed_newlines = re.search(r"(?:\r\n|\r|\n)+\Z", content)
    original_suffix = original_newlines.group(0) if original_newlines else ""
    transformed_suffix = transformed_newlines.group(0) if transformed_newlines else ""
    if original_suffix != transformed_suffix:
        content = content[: len(content) - len(transformed_suffix)] + original_suffix
    return content


def _worker_identity() -> dict[str, object]:
    if resource is None:
        peak_rss_bytes = 0
    else:
        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        peak_rss_bytes = usage if sys.platform == "darwin" else usage * 1024
    return {
        "pythonVersion": platform.python_version(),
        "libcstVersion": importlib.metadata.version("libcst"),
        "peakRssBytes": peak_rss_bytes,
    }


def _scan(files: list[SourceFile], source_model: str) -> dict[str, object]:
    results: list[dict[str, object]] = []
    for source_file in files:
        wrapper = _parse_module(source_file)
        matches = _collect_matches(wrapper, source_model)
        results.append(
            {
                "path": source_file.path,
                "matches": [
                    {"start": _position(match.start), "end": _position(match.end)}
                    for match in matches
                ],
            }
        )
    return {
        "schemaVersion": PROTOCOL_VERSION,
        "kind": "scan-result",
        "files": results,
        "worker": _worker_identity(),
    }


def _rewrite(
    files: list[SourceFile], source_model: str, target_model: str
) -> dict[str, object]:
    results: list[dict[str, object]] = []
    for source_file in files:
        wrapper = _parse_module(source_file)
        matches = _collect_matches(wrapper, source_model)
        transformed = wrapper.visit(_ModelRewriteTransformer(matches, target_model))
        content = _restore_lexical_envelope(source_file.content, transformed.code)
        results.append(
            {
                "path": source_file.path,
                "content": content,
                "changedCount": len(matches),
            }
        )
    return {
        "schemaVersion": PROTOCOL_VERSION,
        "kind": "rewrite-result",
        "files": results,
        "worker": _worker_identity(),
    }


def _handle_request(value: object) -> dict[str, object]:
    request = _expect_object(value, "request")
    operation = request.get("operation")
    expected_keys = (
        {"schemaVersion", "operation", "sourceModel", "files"}
        if operation == "scan"
        else {"schemaVersion", "operation", "sourceModel", "targetModel", "files"}
    )
    _expect_exact_keys(request, expected_keys, "request")
    if request["schemaVersion"] != PROTOCOL_VERSION:
        raise RequestError("Unsupported worker protocol version.")
    if operation not in {"scan", "rewrite"}:
        raise RequestError("Unsupported worker operation.")
    source_model = request["sourceModel"]
    if not isinstance(source_model, str) or MODEL_IDENTIFIER.fullmatch(source_model) is None:
        raise RequestError("sourceModel must be a stable model identifier.")
    files = _parse_files(request["files"])
    if operation == "scan":
        return _scan(files, source_model)
    target_model = request["targetModel"]
    if not isinstance(target_model, str) or MODEL_IDENTIFIER.fullmatch(target_model) is None:
        raise RequestError("targetModel must be a stable model identifier.")
    if target_model == source_model:
        raise RequestError("targetModel must differ from sourceModel.")
    return _rewrite(files, source_model, target_model)


def main() -> int:
    try:
        request = json.load(sys.stdin)
        response = _handle_request(request)
    except (RequestError, json.JSONDecodeError) as error:
        response = {
            "schemaVersion": PROTOCOL_VERSION,
            "kind": "error",
            "message": str(error),
        }
    json.dump(response, sys.stdout, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
