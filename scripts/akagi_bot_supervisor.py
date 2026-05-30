"""Watchdog wrapper around akagi_bot_server.py.

Akagi's bundled `libriichi.so` is built with `panic = "abort"`: any panic
inside the Rust state machine SIGABRTs the child process. We can't catch
those from Python. This supervisor owns the child process, forwards events,
and on crash:

  1. Emits a single line `{"type":"crash","returncode":...,"event":...,
     "stderr_tail":"..."}` so the arena knows the current kyoku is poisoned.
  2. For every subsequent event in this epoch, returns `{"type":"none"}` so
     the caller keeps making forward progress.
  3. When the next `start_game` arrives, restarts the child, replays setup,
     then forwards events normally again.

Wire protocol matches `akagi_bot_server.py` and `mortal_bot_server.py`:
    > {"type":"setup","player_id":0..2,"akagi_pkg":"/path/to/bot_3p"}
    < {"type":"ready"}
    > <mjai event>
    < <bot reaction or {"type":"none"} or {"type":"crash",...}>

All errors flow to stdout as `{"type":"error",...}` lines (never silently
swallowed); supervisor's own tracebacks go to stderr.
"""

from __future__ import annotations

import collections
import json
import subprocess
import sys
import threading
import traceback
from pathlib import Path

WORKER = Path(__file__).resolve().parent / "akagi_bot_server.py"


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


class StderrTail:
    """Capture last N lines of child stderr in a background thread."""

    def __init__(self, stream, maxlen=20):
        self.buf = collections.deque(maxlen=maxlen)
        self._stream = stream
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self):
        try:
            for line in self._stream:
                self.buf.append(line.rstrip("\n"))
                # Mirror to our own stderr so the operator sees panics live.
                sys.stderr.write(line)
                sys.stderr.flush()
        except Exception:
            pass

    def snapshot(self) -> str:
        return "\n".join(self.buf)


class Worker:
    def __init__(self, setup_payload: dict):
        self.setup_payload = setup_payload
        self.proc: subprocess.Popen | None = None
        self.tail: StderrTail | None = None

    def start(self) -> tuple[bool, str]:
        """Spawn child and run handshake. Returns (ok, error_message)."""
        try:
            self.proc = subprocess.Popen(
                [sys.executable, str(WORKER)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
            )
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return False, f"spawn: {type(e).__name__}: {e}"
        self.tail = StderrTail(self.proc.stderr)

        try:
            self.proc.stdin.write(json.dumps(self.setup_payload) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return False, f"handshake io: {type(e).__name__}: {e}"

        if not line:
            return False, f"worker exited during setup; stderr tail: {self.tail.snapshot()}"
        try:
            resp = json.loads(line)
        except Exception as e:
            return False, f"handshake parse: {e}; raw: {line!r}"
        if resp.get("type") != "ready":
            return False, f"worker setup error: {resp}"
        return True, ""

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def returncode(self) -> int | None:
        return None if self.proc is None else self.proc.poll()

    def send(self, line: str) -> tuple[str | None, str | None]:
        """Write one event line, read one reply line.

        Returns (reply, error). On crash, reply is None and error describes it.
        """
        if not self.is_alive():
            return None, f"worker dead before send (rc={self.returncode()})"
        try:
            self.proc.stdin.write(line + "\n")
            self.proc.stdin.flush()
        except BrokenPipeError:
            return None, f"broken pipe on send (rc={self.returncode()})"
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return None, f"send: {type(e).__name__}: {e}"

        try:
            reply = self.proc.stdout.readline()
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return None, f"recv: {type(e).__name__}: {e}"

        if not reply:
            return None, f"worker exited during react (rc={self.returncode()})"
        return reply.rstrip("\n"), None

    def stderr_tail(self) -> str:
        return self.tail.snapshot() if self.tail else ""

    def kill(self):
        if self.proc is None:
            return
        try:
            self.proc.kill()
            self.proc.wait(timeout=3)
        except Exception:
            pass


def main() -> None:
    first = sys.stdin.readline().strip()
    if not first:
        emit({"type": "error", "msg": "empty stdin before setup"})
        sys.exit(1)
    try:
        setup = json.loads(first)
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "msg": f"setup parse: {e}", "event": first})
        sys.exit(1)
    if setup.get("type") != "setup":
        emit({"type": "error", "msg": f"expected setup, got {setup}"})
        sys.exit(1)

    worker = Worker(setup)
    ok, err_msg = worker.start()
    if not ok:
        emit({"type": "error", "msg": err_msg})
        sys.exit(1)
    emit({"type": "ready"})

    # Track current epoch state. After a crash we suppress reactions until the
    # next start_game.
    poisoned = False

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        # Determine event type early so we can decide whether to respawn on
        # start_game.
        try:
            ev = json.loads(line)
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "msg": f"event parse: {e}", "event": line})
            continue
        et = ev.get("type")

        # Hot-swap seat: forward to worker (or restart it first if dead).
        if et == "re_setup":
            if not worker.is_alive():
                worker = Worker({**setup, "player_id": int(ev["player_id"])})
                ok, err_msg = worker.start()
                if not ok:
                    emit({"type": "error", "msg": f"respawn-on-re_setup: {err_msg}"})
                    continue
                # Worker emitted its own ready during start(); we already consumed it.
                emit({"type": "ready"})
                poisoned = False
                continue
            # Live worker: forward re_setup
            reply, send_err = worker.send(line)
            if send_err:
                emit({"type": "crash", "msg": send_err, "event": line,
                      "stderr_tail": worker.stderr_tail()})
                poisoned = True
                continue
            sys.stdout.write(reply + "\n")
            sys.stdout.flush()
            poisoned = False
            continue

        # Respawn on next start_game if previously poisoned.
        if poisoned and et == "start_game":
            worker.kill()
            worker = Worker(setup)
            ok, err_msg = worker.start()
            if not ok:
                emit({"type": "error", "msg": f"respawn-on-start_game: {err_msg}"})
                continue
            poisoned = False

        if poisoned:
            emit({"type": "none"})
            continue

        reply, send_err = worker.send(line)
        if send_err:
            emit({"type": "crash", "msg": send_err, "event": line,
                  "stderr_tail": worker.stderr_tail()})
            poisoned = True
            continue
        sys.stdout.write(reply + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except BaseException as e:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "msg": f"supervisor fatal: {type(e).__name__}: {e}"})
        sys.exit(1)
