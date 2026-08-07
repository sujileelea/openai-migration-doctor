import importlib.metadata
import json
import os
import platform
import sys


request = json.load(sys.stdin)
if "MIGRATION_DOCTOR_PHASE7_SECRET" in os.environ:
    response = {
        "schemaVersion": "1.1.0",
        "kind": "error",
        "message": "ambient secret reached the worker",
    }
else:
    response = {
        "schemaVersion": "1.1.0",
        "kind": "scan-result",
        "files": [
            {"path": source_file["path"], "matches": [], "assistants": []}
            for source_file in request["files"]
        ],
        "worker": {
            "pythonVersion": platform.python_version(),
            "libcstVersion": importlib.metadata.version("libcst"),
            "peakRssBytes": 0,
        },
    }
json.dump(response, sys.stdout, separators=(",", ":"), sort_keys=True)
sys.stdout.write("\n")
