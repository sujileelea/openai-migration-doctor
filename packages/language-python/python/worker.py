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
    ImportAssignment,
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


PROTOCOL_VERSION = "1.1.0"
MODEL_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$")
OPENAI_CLIENT_CONSTRUCTORS = frozenset({"openai.OpenAI", "openai.AsyncOpenAI"})
SUPPORTED_REASON_CODE = "manual-migration-required"


@dataclass(frozen=True)
class MethodRule:
    features: tuple[str, ...]
    request_facets: bool = False
    streaming: bool = False
    tools: bool = False


ASSISTANTS_METHOD_RULES = {
    ("beta", "assistants", "create"): MethodRule(
        ("assistants",), request_facets=True
    ),
    ("beta", "assistants", "retrieve"): MethodRule(("assistants",)),
    ("beta", "assistants", "update"): MethodRule(
        ("assistants",), request_facets=True
    ),
    ("beta", "assistants", "list"): MethodRule(("assistants",)),
    ("beta", "assistants", "delete"): MethodRule(("assistants",)),
    ("beta", "threads", "create"): MethodRule(
        ("threads",), request_facets=True
    ),
    ("beta", "threads", "retrieve"): MethodRule(("threads",)),
    ("beta", "threads", "update"): MethodRule(
        ("threads",), request_facets=True
    ),
    ("beta", "threads", "delete"): MethodRule(("threads",)),
    ("beta", "threads", "create_and_run"): MethodRule(
        ("threads", "runs"), request_facets=True
    ),
    ("beta", "threads", "create_and_run_poll"): MethodRule(
        ("threads", "runs"), request_facets=True
    ),
    ("beta", "threads", "create_and_run_stream"): MethodRule(
        ("threads", "runs"), request_facets=True, streaming=True
    ),
    ("beta", "threads", "messages", "create"): MethodRule(
        ("threads",), request_facets=True
    ),
    ("beta", "threads", "messages", "retrieve"): MethodRule(("threads",)),
    ("beta", "threads", "messages", "update"): MethodRule(
        ("threads",), request_facets=True
    ),
    ("beta", "threads", "messages", "list"): MethodRule(("threads",)),
    ("beta", "threads", "messages", "delete"): MethodRule(("threads",)),
    ("beta", "threads", "runs", "create"): MethodRule(
        ("threads", "runs"), request_facets=True
    ),
    ("beta", "threads", "runs", "retrieve"): MethodRule(("threads", "runs")),
    ("beta", "threads", "runs", "update"): MethodRule(("threads", "runs")),
    ("beta", "threads", "runs", "list"): MethodRule(("threads", "runs")),
    ("beta", "threads", "runs", "cancel"): MethodRule(("threads", "runs")),
    ("beta", "threads", "runs", "create_and_poll"): MethodRule(
        ("threads", "runs"), request_facets=True
    ),
    ("beta", "threads", "runs", "create_and_stream"): MethodRule(
        ("threads", "runs"), request_facets=True, streaming=True
    ),
    ("beta", "threads", "runs", "poll"): MethodRule(("threads", "runs")),
    ("beta", "threads", "runs", "stream"): MethodRule(
        ("threads", "runs"), request_facets=True, streaming=True
    ),
    ("beta", "threads", "runs", "submit_tool_outputs"): MethodRule(
        ("threads", "runs"), request_facets=True, tools=True
    ),
    (
        "beta",
        "threads",
        "runs",
        "submit_tool_outputs_and_poll",
    ): MethodRule(("threads", "runs"), tools=True),
    (
        "beta",
        "threads",
        "runs",
        "submit_tool_outputs_stream",
    ): MethodRule(("threads", "runs"), streaming=True, tools=True),
    ("beta", "threads", "runs", "steps", "retrieve"): MethodRule(
        ("threads", "runs")
    ),
    ("beta", "threads", "runs", "steps", "list"): MethodRule(
        ("threads", "runs")
    ),
}


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


@dataclass(frozen=True)
class ClientBinding:
    position: CodePosition
    pattern: str


@dataclass(frozen=True)
class AssistantFeature:
    feature: str
    disposition: str
    pattern: str
    reason_code: str


@dataclass(frozen=True)
class AssistantCall:
    start: CodePosition
    end: CodePosition
    features: tuple[AssistantFeature, ...]


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


def _constructor_pattern(
    visitor: cst.CSTVisitor, node: cst.BaseExpression
) -> str | None:
    if not _is_openai_constructor(visitor, node):
        return None
    chain = _attribute_chain(node)
    if chain is None:
        return None
    root = chain[0]
    scope = visitor.get_metadata(ScopeProvider, root, None)
    if scope is None:
        return None
    try:
        root_assignments = list(scope[root.value])
    except KeyError:
        return None
    if len(root_assignments) != 1 or not isinstance(root_assignments[0], ImportAssignment):
        return None
    if not _is_direct_scope_statement(visitor, root_assignments[0].node):
        return None
    if isinstance(node, cst.Name) and node.value in {"OpenAI", "AsyncOpenAI"}:
        return "direct"
    if chain[1] in (
        ["openai", "OpenAI"],
        ["openai", "AsyncOpenAI"],
    ):
        return "direct"
    return "import-alias"


def _attribute_chain(node: cst.BaseExpression) -> tuple[cst.Name, list[str]] | None:
    segments: list[str] = []
    current = node
    while isinstance(current, cst.Attribute):
        segments.append(current.attr.value)
        current = current.value
    if not isinstance(current, cst.Name):
        return None
    return current, [current.value, *reversed(segments)]


def _is_direct_scope_statement(
    visitor: cst.CSTVisitor, node: cst.BaseSmallStatement
) -> bool:
    line = visitor.get_metadata(ParentNodeProvider, node, None)
    if not isinstance(line, cst.SimpleStatementLine):
        return False
    body = visitor.get_metadata(ParentNodeProvider, line, None)
    if isinstance(body, cst.Module):
        return True
    if not isinstance(body, cst.IndentedBlock):
        return False
    return isinstance(visitor.get_metadata(ParentNodeProvider, body, None), cst.FunctionDef)


class _ClientAssignmentCollector(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (
        ParentNodeProvider,
        PositionProvider,
        QualifiedNameProvider,
        ScopeProvider,
    )

    def __init__(self) -> None:
        self.clients: dict[cst.Name, ClientBinding] = {}

    def visit_Assign(self, node: cst.Assign) -> None:
        if not (
            len(node.targets) == 1
            and _is_direct_scope_statement(self, node)
            and isinstance(node.targets[0].target, cst.Name)
            and isinstance(node.value, cst.Call)
        ):
            return
        pattern = _constructor_pattern(self, node.value.func)
        if pattern is not None:
            target = node.targets[0].target
            self.clients[target] = ClientBinding(
                position=self.get_metadata(PositionProvider, target).start,
                pattern=pattern,
            )

    def visit_AnnAssign(self, node: cst.AnnAssign) -> None:
        if not (
            isinstance(node.target, cst.Name)
            and _is_direct_scope_statement(self, node)
            and isinstance(node.value, cst.Call)
        ):
            return
        pattern = _constructor_pattern(self, node.value.func)
        if pattern is not None:
            self.clients[node.target] = ClientBinding(
                position=self.get_metadata(PositionProvider, node.target).start,
                pattern=pattern,
            )


def _bound_client_pattern(
    visitor: cst.CSTVisitor,
    root: cst.Name,
    call_position: CodePosition,
    client_assignments: dict[cst.Name, ClientBinding],
) -> str | None:
    scope = visitor.get_metadata(ScopeProvider, root, None)
    if scope is None:
        return None
    try:
        assignments = list(scope[root.value])
    except KeyError:
        return None
    if len(assignments) != 1:
        return None
    assignment_node = getattr(assignments[0], "node", None)
    if not isinstance(assignment_node, cst.Name):
        return None
    binding = client_assignments.get(assignment_node)
    if binding is None:
        return None
    if (binding.position.line, binding.position.column) >= (
        call_position.line,
        call_position.column,
    ):
        return None
    return binding.pattern


class _TranscriptionCallCollector(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider, ScopeProvider)

    def __init__(
        self,
        source_model: str,
        client_assignments: dict[cst.Name, ClientBinding],
    ) -> None:
        self.source_model = source_model
        self.client_assignments = client_assignments
        self.matches: list[Match] = []

    def _is_bound_client(self, root: cst.Name, call_position: CodePosition) -> bool:
        return (
            _bound_client_pattern(self, root, call_position, self.client_assignments)
            is not None
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


def _add_assistant_feature(
    results: list[AssistantFeature],
    feature: str,
    pattern: str,
    disposition: str = "supported",
    reason_code: str = SUPPORTED_REASON_CODE,
) -> None:
    candidate = AssistantFeature(
        feature=feature,
        disposition=disposition,
        pattern=pattern,
        reason_code=reason_code,
    )
    if candidate not in results:
        results.append(candidate)


def _keyword_argument(call: cst.Call, name: str) -> tuple[str, cst.BaseExpression | None]:
    matches = [
        argument.value
        for argument in call.args
        if not argument.star
        and isinstance(argument.keyword, cst.Name)
        and argument.keyword.value == name
    ]
    if len(matches) > 1:
        return "dynamic", None
    if len(matches) == 1:
        return "found", matches[0]
    return "missing", None


def _string_literal(node: cst.BaseExpression | None) -> str | None:
    if not isinstance(node, cst.SimpleString):
        return None
    value = node.evaluated_value
    return value if isinstance(value, str) else None


def _static_dict(
    node: cst.BaseExpression | None,
) -> dict[str, cst.BaseExpression] | None:
    if not isinstance(node, cst.Dict):
        return None
    result: dict[str, cst.BaseExpression] = {}
    for element in node.elements:
        if not isinstance(element, cst.DictElement):
            return None
        key = _string_literal(element.key)
        if key is None or key in result:
            return None
        result[key] = element.value
    return result


def _collect_tool_features(
    call: cst.Call, pattern: str, results: list[AssistantFeature]
) -> None:
    tools_status, tools_value = _keyword_argument(call, "tools")
    if tools_status == "dynamic":
        _add_assistant_feature(
            results, "tools", "dynamic-request", "abstained", "dynamic-tools"
        )
    elif tools_status == "found":
        if not isinstance(tools_value, cst.List):
            _add_assistant_feature(
                results, "tools", "dynamic-request", "abstained", "dynamic-tools"
            )
        elif tools_value.elements:
            known_types: set[str] = set()
            all_types_known = True
            for element in tools_value.elements:
                if not isinstance(element, cst.Element):
                    all_types_known = False
                    continue
                item = _static_dict(element.value)
                tool_type = _string_literal(item.get("type")) if item is not None else None
                if tool_type is None:
                    all_types_known = False
                else:
                    known_types.add(tool_type)
            if all_types_known:
                _add_assistant_feature(results, "tools", pattern)
            else:
                _add_assistant_feature(
                    results,
                    "tools",
                    "dynamic-request",
                    "abstained",
                    "dynamic-tools",
                )
            if "file_search" in known_types:
                _add_assistant_feature(results, "file-search", pattern)
            if "code_interpreter" in known_types:
                _add_assistant_feature(results, "code-interpreter", pattern)

    resources_status, resources_value = _keyword_argument(call, "tool_resources")
    if resources_status == "dynamic":
        _add_assistant_feature(
            results,
            "tools",
            "dynamic-request",
            "abstained",
            "dynamic-tool-resources",
        )
    elif resources_status == "found":
        resources = _static_dict(resources_value)
        if resources is None:
            _add_assistant_feature(
                results,
                "tools",
                "dynamic-request",
                "abstained",
                "dynamic-tool-resources",
            )
        else:
            if "file_search" in resources:
                _add_assistant_feature(results, "tools", pattern)
                _add_assistant_feature(results, "file-search", pattern)
            if "code_interpreter" in resources:
                _add_assistant_feature(results, "tools", pattern)
                _add_assistant_feature(results, "code-interpreter", pattern)

    _collect_message_attachment_features(call, pattern, results)


def _collect_attachment_tools(
    value: cst.BaseExpression | None,
    pattern: str,
    results: list[AssistantFeature],
) -> None:
    if not isinstance(value, cst.List):
        _add_assistant_feature(
            results, "tools", "dynamic-request", "abstained", "dynamic-tools"
        )
        return
    for element in value.elements:
        if not isinstance(element, cst.Element):
            _add_assistant_feature(
                results, "tools", "dynamic-request", "abstained", "dynamic-tools"
            )
            continue
        attachment = _static_dict(element.value)
        if attachment is None:
            _add_assistant_feature(
                results, "tools", "dynamic-request", "abstained", "dynamic-tools"
            )
            continue
        tools = attachment.get("tools")
        if tools is None:
            continue
        synthetic = cst.Call(
            func=cst.Name("attachment_tools"),
            args=[cst.Arg(keyword=cst.Name("tools"), value=tools)],
        )
        _collect_tool_features(synthetic, pattern, results)


def _collect_message_list_attachments(
    value: cst.BaseExpression | None,
    pattern: str,
    results: list[AssistantFeature],
) -> None:
    if not isinstance(value, cst.List):
        return
    for element in value.elements:
        if not isinstance(element, cst.Element):
            continue
        message = _static_dict(element.value)
        attachments = message.get("attachments") if message is not None else None
        if attachments is not None:
            _collect_attachment_tools(attachments, pattern, results)


def _collect_message_attachment_features(
    call: cst.Call, pattern: str, results: list[AssistantFeature]
) -> None:
    attachments_status, attachments = _keyword_argument(call, "attachments")
    if attachments_status == "dynamic":
        _add_assistant_feature(
            results, "tools", "dynamic-request", "abstained", "dynamic-tools"
        )
    elif attachments_status == "found":
        _collect_attachment_tools(attachments, pattern, results)

    for name in ("messages", "additional_messages"):
        status, messages = _keyword_argument(call, name)
        if status == "found":
            _collect_message_list_attachments(messages, pattern, results)

    thread_status, thread = _keyword_argument(call, "thread")
    if thread_status == "found":
        thread_fields = _static_dict(thread)
        if thread_fields is not None and "messages" in thread_fields:
            _collect_message_list_attachments(thread_fields["messages"], pattern, results)


def _assistant_features(
    call: cst.Call, rule: MethodRule, pattern: str
) -> tuple[AssistantFeature, ...]:
    results: list[AssistantFeature] = []
    for feature in rule.features:
        _add_assistant_feature(results, feature, pattern)
    if rule.streaming:
        _add_assistant_feature(results, "streaming", pattern)
    if rule.tools:
        _add_assistant_feature(results, "tools", pattern)

    if rule.request_facets:
        stream_status, stream_value = _keyword_argument(call, "stream")
        if stream_status == "dynamic":
            _add_assistant_feature(
                results,
                "streaming",
                "dynamic-request",
                "abstained",
                "dynamic-stream",
            )
        elif stream_status == "found":
            if isinstance(stream_value, cst.Name) and stream_value.value == "True":
                _add_assistant_feature(results, "streaming", pattern)
            elif not (isinstance(stream_value, cst.Name) and stream_value.value == "False"):
                _add_assistant_feature(
                    results,
                    "streaming",
                    "dynamic-request",
                    "abstained",
                    "dynamic-stream",
                )
        _collect_tool_features(call, pattern, results)
    return tuple(results)


def _prefix_features(path: tuple[str, ...]) -> tuple[str, ...]:
    if len(path) >= 2 and path[:2] == ("beta", "assistants"):
        return ("assistants",)
    if len(path) >= 2 and path[:2] == ("beta", "threads"):
        return ("threads", "runs") if "runs" in path else ("threads",)
    return ()


class _AssistantCallCollector(cst.CSTVisitor):
    METADATA_DEPENDENCIES = (PositionProvider, ScopeProvider)

    def __init__(self, client_assignments: dict[cst.Name, ClientBinding]) -> None:
        self.client_assignments = client_assignments
        self.calls: list[AssistantCall] = []

    def visit_Call(self, node: cst.Call) -> None:
        chain = _attribute_chain(node.func)
        if chain is None:
            return
        root, segments = chain
        path = tuple(segments[1:])
        rule = ASSISTANTS_METHOD_RULES.get(path)
        prefix_features = _prefix_features(path)
        if rule is None and not prefix_features:
            return
        callee_range = self.get_metadata(PositionProvider, node.func)
        pattern = _bound_client_pattern(
            self, root, callee_range.start, self.client_assignments
        )
        if pattern is None:
            return
        if rule is not None:
            features = _assistant_features(node, rule, pattern)
        else:
            features = tuple(
                AssistantFeature(
                    feature=feature,
                    disposition="abstained",
                    pattern="dynamic-member",
                    reason_code="unsupported-method",
                )
                for feature in prefix_features
            )
        if features:
            self.calls.append(
                AssistantCall(
                    start=callee_range.start,
                    end=callee_range.end,
                    features=features,
                )
            )


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
    wrapper: MetadataWrapper,
    source_model: str,
    client_assignments: dict[cst.Name, ClientBinding] | None = None,
) -> list[Match]:
    if client_assignments is None:
        assignments = _ClientAssignmentCollector()
        wrapper.visit(assignments)
        client_assignments = assignments.clients
    calls = _TranscriptionCallCollector(source_model, client_assignments)
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


def _collect_assistant_calls(
    wrapper: MetadataWrapper, client_assignments: dict[cst.Name, ClientBinding]
) -> list[AssistantCall]:
    calls = _AssistantCallCollector(client_assignments)
    wrapper.visit(calls)
    calls.calls.sort(
        key=lambda call: (
            call.start.line,
            call.start.column,
            call.end.line,
            call.end.column,
        )
    )
    return calls.calls


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
        assignments = _ClientAssignmentCollector()
        wrapper.visit(assignments)
        matches = _collect_matches(wrapper, source_model, assignments.clients)
        assistant_calls = _collect_assistant_calls(wrapper, assignments.clients)
        results.append(
            {
                "path": source_file.path,
                "matches": [
                    {"start": _position(match.start), "end": _position(match.end)}
                    for match in matches
                ],
                "assistants": [
                    {
                        "start": _position(call.start),
                        "end": _position(call.end),
                        "features": [
                            {
                                "feature": feature.feature,
                                "disposition": feature.disposition,
                                "pattern": feature.pattern,
                                "reasonCode": feature.reason_code,
                            }
                            for feature in call.features
                        ],
                    }
                    for call in assistant_calls
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
