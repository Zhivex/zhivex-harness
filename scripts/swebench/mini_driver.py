"""Original mini-SWE-agent loop with bounded telemetry and a Docker environment."""
import json
import os
import subprocess
import sys
import time


def run(request):
    os.environ["MSWEA_SILENT_STARTUP"] = "1"
    os.environ["MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT"] = "1"
    from minisweagent.agents.default import DefaultAgent
    from minisweagent.config import builtin_config_dir
    from minisweagent.environments.docker import DockerEnvironment
    from minisweagent.models.litellm_response_model import LitellmResponseModel
    from minisweagent.exceptions import LimitsExceeded
    import yaml

    limits = request["limits"]
    totals = {"inputTokens": 0, "outputTokens": 0, "cachedInputTokens": 0, "modelCalls": 0, "usageComplete": True}

    from minisweagent.models.litellm_model import LitellmModel
    qwen = request.get("provider", "openai") == "qwen"

    class ObservedModel(LitellmModel if qwen else LitellmResponseModel):
        def _query(self, messages, **kwargs):
            if totals["inputTokens"] >= limits["inputTokens"] or totals["outputTokens"] >= limits["outputTokens"]:
                raise LimitsExceeded({"role": "exit", "content": "Token limit", "extra": {"exit_status": "LimitsExceeded"}})
            totals["modelCalls"] += 1
            try:
                response = super()._query(messages, **kwargs)
                usage = getattr(response, "usage", None)
                input_tokens = getattr(usage, "prompt_tokens" if qwen else "input_tokens", None)
                output_tokens = getattr(usage, "completion_tokens" if qwen else "output_tokens", None)
                if usage is None or input_tokens is None or output_tokens is None:
                    totals["usageComplete"] = False
                else:
                    totals["inputTokens"] += input_tokens
                    totals["outputTokens"] += output_tokens
                    details = getattr(usage, "prompt_tokens_details" if qwen else "input_tokens_details", None)
                    totals["cachedInputTokens"] += getattr(details, "cached_tokens", 0) or 0
                return response
            except Exception:
                totals["usageComplete"] = False
                raise

    class ObservedEnvironment(DockerEnvironment):
        calls = 0

        def execute(self, action, **kwargs):
            self.calls += 1
            result = super().execute(action, **kwargs)
            result["output"] = result.get("output", "")[:100000]
            return result

        def cleanup(self):
            if getattr(self, "container_id", None):
                subprocess.run(["docker", "rm", "-f", self.container_id], capture_output=True, timeout=60)
                self.container_id = None

    config = yaml.safe_load((builtin_config_dir / "benchmarks" / "swebench.yaml").read_text())
    kwargs = {"max_output_tokens": limits["outputPerTurn"], "reasoning": {"effort": "low"},
              "store": False, "timeout": 90, "num_retries": 0, "parallel_tool_calls": True}
    if qwen:
        kwargs = {"max_tokens": limits["outputPerTurn"], "timeout": 90, "num_retries": 0,
                  "api_base": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
                  "api_key": os.environ.get("DASHSCOPE_API_KEY") or os.environ.get("QWEN_API_KEY"),
                  "extra_body": {"enable_thinking": False}}
    if not qwen and os.environ.get("OPENAI_BASE_URL"):
        kwargs["api_base"] = os.environ["OPENAI_BASE_URL"]
    model = ObservedModel(model_name="openai/" + request["model"], model_kwargs=kwargs, cost_tracking="ignore_errors",
                          observation_template=config["model"]["observation_template"],
                          format_error_template=config["model"]["format_error_template"])
    env = None
    started = time.monotonic()
    status = "failed"
    failure = None
    patch = ""
    phase = "setup"
    try:
        env = ObservedEnvironment(image=request["image"], cwd="/testbed", timeout=60,
                                  env=config["environment"]["env"], interpreter=config["environment"]["interpreter"],
                                  run_args=["--rm", "--platform", "linux/amd64", "--network", "none",
                                            "--memory", f"{limits['memoryMb']}m", "--cpus", str(limits["cpus"]),
                                            "--pids-limit", "256", "--label", f"com.zhivex.benchmark.run={request['runToken']}", "--cap-drop", "ALL",
                                            "--security-opt", "no-new-privileges"],
                                  container_timeout=f"{limits['timeoutSeconds'] + 60}s")
        phase = "agent"
        agent_config = {**config["agent"], "step_limit": limits["steps"], "cost_limit": 0,
                        "wall_time_limit_seconds": limits["timeoutSeconds"]}
        # Original upstream prompts and control loop. Only limits/telemetry differ.
        agent = DefaultAgent(model, env, **agent_config)
        info = agent.run(request["problem"])
        status = info.get("exit_status", "failed")
        # The actual repository is authoritative; never trust a model-provided patch string.
    except Exception as error:
        failure = type(error).__name__
        totals["usageComplete"] = False
    finally:
        if env is not None:
            try:
                subprocess.run(["docker", "exec", "-w", "/testbed", env.container_id,
                                "git", "add", "-N", "--", "."], capture_output=True, timeout=30, check=True)
                result = subprocess.run(["docker", "exec", "-w", "/testbed", env.container_id,
                                         "git", "-c", "core.fsmonitor=false", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD"],
                                        capture_output=True, text=True, timeout=30, check=True)
                patch = result.stdout
            except Exception:
                failure = failure or "PatchExportError"
            env.cleanup()
    return {"schemaVersion": 1, "candidate": "mini-swe-agent", "instanceId": request["instanceId"],
            "status": status, "failure": failure, "phase": phase, "durationMs": (time.monotonic() - started) * 1000,
            "approvals": 0, "toolCalls": env.calls if env else 0, "patch": patch, **totals}


if __name__ == "__main__":
    raw = sys.stdin.read(256001)
    if len(raw) > 256000:
        raise ValueError("Driver request too large")
    import contextlib
    with contextlib.redirect_stdout(sys.stderr):
        result = run(json.loads(raw))
    print(json.dumps(result))
