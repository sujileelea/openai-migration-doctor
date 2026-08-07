import json
import sys


request = json.load(sys.stdin)
response = {
    "schemaVersion": "1.0.0",
    "kind": "scan-result" if request["operation"] == "scan" else "rewrite-result",
    "files": [
        (
            {"path": source_file["path"], "matches": []}
            if request["operation"] == "scan"
            else {
                "path": source_file["path"],
                "content": source_file["content"],
                "changedCount": 0,
            }
        )
        for source_file in request["files"]
    ],
    "worker": {
        "pythonVersion": "3.13.11",
        "libcstVersion": "1.8.6",
        "peakRssBytes": 0,
    },
}
json.dump(response, sys.stdout, separators=(",", ":"), sort_keys=True)
sys.stdout.write("\n")
