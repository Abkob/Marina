"""Bound Simulator launch/tests and retain diagnostics even after a launch failure."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

device = sys.argv[1]
output = Path("native/Build")
(output / "Previews").mkdir(parents=True, exist_ok=True)


def run(args, seconds=30, log=None):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, timeout=seconds)
        if log:
            Path(log).write_text(result.stdout)
        print(result.stdout[-12000:], flush=True)
        return result.returncode
    except subprocess.TimeoutExpired as error:
        print(f"Timed out after {seconds}s: {' '.join(args[:4])}", flush=True)
        if log:
            Path(log).write_bytes(error.stdout or b"")
        return 124


def diagnostics():
    run(["xcrun", "simctl", "spawn", device, "log", "show", "--last", "3m", "--style", "compact",
         "--predicate", 'process == "Marina" OR eventMessage CONTAINS "com.abkob.marina"'],
        seconds=30, log=output / "app-console.log")
    reports = output / "CrashReports"
    reports.mkdir(exist_ok=True)
    for report in (Path.home() / "Library/Logs/DiagnosticReports").glob("Marina*"):
        if report.is_file():
            shutil.copy2(report, reports / report.name)


app = "native/Build/Simulator/Build/Products/Debug-iphonesimulator/Marina.app"
status = run(["xcrun", "simctl", "install", device, app], seconds=60)
if status == 0:
    status = run(["xcrun", "simctl", "launch", device, "com.abkob.marina",
                  "--ui-testing", "--checkin-preview"], log=output / "launch.log")
    time.sleep(3)
    run(["xcrun", "simctl", "io", device, "screenshot", str(output / "Previews/Native-check-in.png")])
diagnostics()
if status:
    sys.exit(status)

command = ["xcodebuild", "-project", "native/Marina/Marina.xcodeproj", "-scheme", "Marina",
           "-destination", f"platform=iOS Simulator,id={device}", "-parallel-testing-enabled", "NO",
           "-derivedDataPath", "native/Build/Simulator", "-resultBundlePath", "native/Build/Tests.xcresult",
           "-test-timeouts-enabled", "YES", "-maximum-test-execution-time-allowance", "60",
           "IPHONEOS_DEPLOYMENT_TARGET=18.4", "CODE_SIGN_IDENTITY=-", "CODE_SIGNING_ALLOWED=YES", "test-without-building"]
with Path("native-ui-tests.log").open("w") as log:
    process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        status = process.wait(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        status = 124
print(Path("native-ui-tests.log").read_text()[-16000:], flush=True)
diagnostics()
for kind, directory in [("attachments", "Previews"), ("diagnostics", "Diagnostics")]:
    run(["xcrun", "xcresulttool", "export", kind, "--path", "native/Build/Tests.xcresult",
         "--output-path", str(output / directory)], seconds=45)
sys.exit(status)
