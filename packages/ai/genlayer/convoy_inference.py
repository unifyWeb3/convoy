# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json

from genlayer import *


ALLOWED_SCHEMAS = ("convoy_plan", "convoy_critic_verdict")
MAX_MESSAGES_JSON_CHARS = 80_000
MAX_SCHEMA_JSON_CHARS = 20_000


class ConvoyInference(gl.Contract):
    """Stateless GenLayer transport for Convoy's existing LlmCaller boundary."""

    def __init__(self) -> None:
        pass

    @gl.public.write
    def infer(self, schema_name: str, messages_json: str, schema_json: str) -> str:
        if schema_name not in ALLOWED_SCHEMAS:
            raise gl.vm.UserError("unsupported Convoy schema")
        if not isinstance(messages_json, str) or not isinstance(schema_json, str):
            raise gl.vm.UserError("messages_json and schema_json must be strings")
        if len(messages_json) > MAX_MESSAGES_JSON_CHARS:
            raise gl.vm.UserError("messages_json is too large")
        if len(schema_json) > MAX_SCHEMA_JSON_CHARS:
            raise gl.vm.UserError("schema_json is too large")

        try:
            messages = json.loads(messages_json)
            requested_schema = json.loads(schema_json)
        except Exception:
            raise gl.vm.UserError("messages_json and schema_json must contain valid JSON")

        if not isinstance(messages, list) or len(messages) == 0:
            raise gl.vm.UserError("messages_json must contain a non-empty array")
        if not isinstance(requested_schema, dict):
            raise gl.vm.UserError("schema_json must contain a JSON object")

        prompt_parts = [
            "You are the inference backend for Convoy.",
            "Follow the role-tagged conversation below.",
            "Return one JSON object only. It must match the supplied JSON Schema.",
            f"Schema name: {schema_name}",
            "JSON Schema:",
            json.dumps(requested_schema, sort_keys=True, separators=(",", ":")),
            "Conversation:",
        ]

        for position, message in enumerate(messages):
            if not isinstance(message, dict):
                raise gl.vm.UserError(f"message {position} must be an object")
            role = message.get("role")
            content = message.get("content")
            if role not in ("system", "user", "assistant") or not isinstance(content, str):
                raise gl.vm.UserError(f"message {position} has an invalid role or content")
            prompt_parts.append(f"<{role.upper()}>\n{content}\n</{role.upper()}>")

        prompt_parts.append("Return the JSON object only.")
        prompt = "\n\n".join(prompt_parts)

        def run_inference():
            response = gl.nondet.exec_prompt(prompt, response_format="json")
            if not isinstance(response, dict):
                raise gl.vm.UserError("LLM did not return a JSON object")
            return response

        def structurally_valid(candidate) -> bool:
            if not isinstance(candidate, dict):
                return False

            if schema_name == "convoy_plan":
                return (
                    isinstance(candidate.get("order"), list)
                    and isinstance(candidate.get("deferrals"), list)
                    and isinstance(candidate.get("gasBudgetPerItem"), list)
                    and isinstance(candidate.get("rationalePerItem"), list)
                )

            return (
                candidate.get("verdict") in ("APPROVE", "VETO")
                and candidate.get("reason")
                in (
                    "none",
                    "would_revert",
                    "over_budget",
                    "unmet_dependency",
                    "evidence_mismatch",
                )
                and isinstance(candidate.get("evidenceQuote"), str)
                and isinstance(candidate.get("justification"), str)
            )

        def validate_inference(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            candidate = leader_result.calldata
            return structurally_valid(candidate) and structurally_valid(run_inference())

        result = gl.vm.run_nondet_unsafe(run_inference, validate_inference)
        return json.dumps(result, sort_keys=True, separators=(",", ":"))
