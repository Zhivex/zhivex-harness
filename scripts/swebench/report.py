import argparse
import json
from pathlib import Path
from common import summarize, write_json

parser = argparse.ArgumentParser()
parser.add_argument("directory")
args = parser.parse_args()
root = Path(args.directory)
report = summarize(json.loads((root / "manifest.json").read_text()), json.loads((root / "samples.json").read_text()))
write_json(root / "report.json", report)
print(json.dumps(report, indent=2))

lines = ["# SWE-bench comparison", "", report["evidenceBoundary"], "",
         "| Candidate | Imported/final resolved / planned | Candidate resolved / captured | Missing | Grading failures | Cost / resolved (USD) |",
         "| --- | ---: | ---: | ---: | ---: | ---: |"]
for name, group in report["candidates"].items():
    value = group["costPerResolvedUsd"]
    candidate = f"{group['candidateResolved']}/{group['candidateCaptured']}" if group['candidateCaptured'] else 'unknown'
    lines.append(f"| {name} | {group['resolved']}/{group['planned']} | {candidate} | {group['missing']} | {group['gradingFailures']} | {value if value is not None else 'unknown'} |")
lines += ["", f"Paired task resolution difference (Zhivex minus mini): {report['pairedTaskResolutionDifference']:.3f}",
          f"Exploratory task-bootstrap 95% interval: {report['pairedTaskBootstrap95']}", "",
          "Prices are caller-supplied estimates. Unknown usage or pricing never becomes zero cost.",
          "Candidate grading is diagnostic: an unimported candidate never counts as a safe completed Zhivex repair. Missing candidate capture is unknown, not an empty patch.",
          "Resolution additionally requires no changes to protected test/configuration files."]
(root / "report.md").write_text("\n".join(lines) + "\n")
