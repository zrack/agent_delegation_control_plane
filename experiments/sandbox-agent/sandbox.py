"""One-shot Docker execution. The model controls Python text, never Docker arguments."""
from dataclasses import dataclass
from hashlib import sha256
import io
import json
import os
import selectors
import subprocess
import tarfile
import time
from uuid import uuid4

IMAGE = "adcp-invoice-sandbox:v1"
MAX_CODE = 12_000
MAX_ARTIFACT = 32_768
MAX_OUTPUT = 16_384
BOOTSTRAP = '''import json, pathlib, subprocess, sys
payload = json.load(sys.stdin)
pathlib.Path("invoices.csv").write_text(payload["csv"])
pathlib.Path("program.py").write_text(payload["program"])
raise SystemExit(subprocess.call([sys.executable, "-I", "-S", "program.py"]))
'''


class SandboxLimit(RuntimeError):
    pass


def validate_inputs(program, csv_text):
    if (not isinstance(program, str) or not 1 <= len(program) <= MAX_CODE
            or len(program.encode()) > MAX_CODE):
        raise ValueError("Program exceeds its size contract")
    if not isinstance(csv_text, str) or len(csv_text) > 4096 or len(csv_text.encode()) > 4096:
        raise ValueError("Input exceeds its size contract")


def command(argv, *, payload=None, timeout=15, limit=MAX_OUTPUT):
    """Bound both streams while collecting; never buffer an unlimited communicate()."""
    process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    streams = {"stdout": bytearray(), "stderr": bytearray()}
    deadline = time.monotonic() + timeout
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ, "stdout")
            selector.register(process.stderr, selectors.EVENT_READ, "stderr")
            pending = memoryview(payload or b"")
            if pending:
                os.set_blocking(process.stdin.fileno(), False)
                selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
            else:
                process.stdin.close()
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SandboxLimit("timeout")
                for key, _ in selector.select(min(remaining, 0.1)):
                    if key.data == "stdin":
                        try:
                            pending = pending[os.write(process.stdin.fileno(), pending[:4096]):]
                        except BrokenPipeError:
                            pending = memoryview(b"")
                        if not pending:
                            selector.unregister(process.stdin)
                            process.stdin.close()
                        continue
                    chunk = os.read(key.fileobj.fileno(), 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        if sum(map(len, streams.values())) + len(chunk) > limit:
                            raise SandboxLimit("output_limit")
                        streams[key.data].extend(chunk)
        try:
            process.wait(timeout=max(0.01, deadline - time.monotonic()))
        except subprocess.TimeoutExpired as error:
            raise SandboxLimit("timeout") from error
        return process.returncode, bytes(streams["stdout"]), bytes(streams["stderr"])
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
        process.stderr.close()
        if not process.stdin.closed:
            process.stdin.close()


def docker(*args, payload=None, timeout=15, limit=MAX_OUTPUT):
    status, output, _ = command(["docker", *args], payload=payload, timeout=timeout, limit=limit)
    if status:
        # Do not forward arbitrary daemon/child text into application diagnostics.
        raise RuntimeError("Docker operation failed: " + args[0])
    return output


def regular_artifacts(archive, expected_names):
    """Read bounded regular files. Never extract an untrusted tar to the host."""
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as handle:
        members = handle.getmembers()
        if len(members) != len(expected_names) or {member.name for member in members} != set(expected_names):
            raise ValueError("Unexpected artifact set")
        result = {}
        for member in members:
            if not member.isfile() or member.size > MAX_ARTIFACT:
                raise ValueError("Artifact is not a bounded regular file")
            stream = handle.extractfile(member)
            if stream is None:
                raise ValueError("Artifact unavailable")
            result[member.name] = stream.read(MAX_ARTIFACT + 1)
        return result


def regular_artifact(archive, expected_name):
    return regular_artifacts(archive, [expected_name])[expected_name]


@dataclass
class Execution:
    status: str
    exit_code: int | None
    stdout: str
    stderr: str
    artifact: bytes | None
    input_unchanged: bool
    image_id: str
    controls: dict
    cleaned: bool = False


class DockerSandbox:
    def __init__(self, image=IMAGE):
        # Runtime uses the immutable local image ID, even if its friendly tag moves.
        info = json.loads(docker("image", "inspect", image))[0]
        self.image_id = info["Id"]

    def execute(self, program, csv_text, *, timeout=5):
        validate_inputs(program, csv_text)
        name = "adcp-sandbox-" + uuid4().hex
        execution = Execution("failed", None, "", "", None, False, self.image_id, {})
        created = False
        try:
            # No bind mounts, ports, inherited environment, privileged mode or socket.
            docker("create", "--name", name, "--label", "adcp.sandbox-pilot=true", "-i",
                   "--network", "none", "--read-only", "--cap-drop", "ALL",
                   "--security-opt", "no-new-privileges", "--user", "65534:65534",
                   "--memory", "128m", "--memory-swap", "128m", "--cpus", "0.5",
                   "--pids-limit", "32", "--ulimit", "cpu=2:2", "--ulimit", "fsize=65536:65536",
                   "--ulimit", "nofile=64:64", "--log-driver", "none",
                   "--tmpfs", "/work:rw,noexec,nosuid,nodev,size=4m,uid=65534,gid=65534", "--workdir", "/work",
                   self.image_id, "-c", "import time; time.sleep(60)")
            created = True
            info = json.loads(docker("inspect", name))[0]
            host = info["HostConfig"]
            controls = {"network": host["NetworkMode"], "readOnlyRoot": host["ReadonlyRootfs"],
                        "memoryBytes": host["Memory"], "memorySwapBytes": host["MemorySwap"],
                        "nanoCPUs": host["NanoCpus"], "pids": host["PidsLimit"],
                        "capDrop": host["CapDrop"], "securityOpt": host["SecurityOpt"],
                        "user": info["Config"]["User"], "mountTypes": [mount["Type"] for mount in info["Mounts"]],
                        "tmpfs": host["Tmpfs"],
                        "ulimits": {item["Name"]: [item["Soft"], item["Hard"]] for item in host["Ulimits"]}}
            if (controls["network"] != "none" or not controls["readOnlyRoot"]
                    or controls["memoryBytes"] != 128 * 1024 * 1024 or controls["memorySwapBytes"] != 128 * 1024 * 1024
                    or controls["pids"] != 32
                    or controls["nanoCPUs"] != 500_000_000 or controls["user"] != "65534:65534"
                    or any(kind != "tmpfs" for kind in controls["mountTypes"]) or controls["capDrop"] != ["ALL"]
                    or controls["tmpfs"] != {"/work": "rw,noexec,nosuid,nodev,size=4m,uid=65534,gid=65534"}
                    or any(controls["ulimits"].get(key) != value for key, value in
                           {"cpu": [2, 2], "fsize": [65536, 65536], "nofile": [64, 64]}.items())
                    or "no-new-privileges" not in controls["securityOpt"]):
                raise RuntimeError("Sandbox controls differ from required policy")
            execution.controls = controls
            docker("start", name)
            try:
                exit_code, output, errors = command(["docker", "exec", "-i", name, "python3", "-I", "-S", "-c", BOOTSTRAP],
                    payload=json.dumps({"program": program, "csv": csv_text}).encode(), timeout=timeout)
                execution.stdout = output.decode(errors="replace")
                execution.stderr = errors.decode(errors="replace")
                execution.exit_code = exit_code
                execution.status = "completed" if execution.exit_code == 0 else "execution_failed"
                if execution.status == "completed":
                    # A separate non-root collector owns the archive stream; the
                    # job cannot inject into its stdout through same-UID /proc FDs.
                    # Docker cp/export do not expose this bounded tmpfs mount.
                    archive = docker("exec", "--user", "65533:65533", name, "tar", "-C", "/work", "-cf", "-",
                                     "results.json", "invoices.csv", limit=131072)
                    files = regular_artifacts(archive, ["results.json", "invoices.csv"])
                    docker("pause", name)
                    state = json.loads(docker("inspect", name))[0]["State"]
                    if not state["Paused"]:
                        raise RuntimeError("Artifact source is not frozen")
                    execution.artifact = files["results.json"]
                    original = files["invoices.csv"]
                    execution.input_unchanged = sha256(original).digest() == sha256(csv_text.encode()).digest()
            except SandboxLimit as error:
                execution.status = str(error)
            except (ValueError, RuntimeError, tarfile.TarError):
                execution.status = "artifact_invalid" if execution.exit_code == 0 else "execution_failed"
        finally:
            # Also attempt removal after an ambiguous create/transport failure.
            removal, _, _ = command(["docker", "rm", "--force", "--volumes", name])
            if removal and created:
                raise RuntimeError("Sandbox container cleanup failed")
            execution.cleaned = True
        return execution
