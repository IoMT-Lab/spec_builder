import json
import os
import sys
import unittest
from unittest.mock import patch

# Ensure we can import the module under test
TEST_DIR = os.path.dirname(__file__)
PARENT = os.path.abspath(os.path.join(TEST_DIR, ".."))
if PARENT not in sys.path:
    sys.path.append(PARENT)

import fact_extractor as fe  # type: ignore


class TestFactExtractor(unittest.TestCase):
    def setUp(self):
        self.prompt = "Users can sign in with Google; P95 latency < 200ms."
        self.structure = {"cursor": {"sectionIndex": 2, "fieldIndex": 0}, "nextFocus": {"sectionIndex": 2, "fieldIndex": 0}}

    @patch("fact_extractor.get_llm_response_from_context")
    def test_happy_path_valid_json(self, mock_llm):
        mock_llm.return_value = json.dumps({
            "facts": [
                {"text": "Google sign-in", "exact_span": "sign in with Google", "sectionHint": "Requirements", "fieldHint": "Requirement", "attributes": {}, "confidence": 0.96},
                {"text": "P95 < 200ms", "exact_span": "P95 latency < 200ms", "sectionHint": "Success Metrics", "fieldHint": "Acceptance Criteria", "attributes": {"type": "latency", "value": 200, "unit": "ms", "comparator": "<"}, "confidence": 0.91},
            ]
        })
        facts = fe.extract_facts(prompt=self.prompt, structure=self.structure, llm="dummy")
        self.assertEqual(len(facts), 2)
        self.assertEqual(facts[0]["exact_span"], "sign in with Google")

    @patch("fact_extractor.get_llm_response_from_context")
    def test_broken_then_repaired_json(self, mock_llm):
        # First call returns invalid JSON, second returns fixed JSON
        mock_llm.side_effect = [
            "{ facts: [ { text: 'bad json' } ] }",  # invalid
            json.dumps({"facts": [{"text": "ok", "exact_span": "ok", "sectionHint": "", "fieldHint": "", "attributes": {}, "confidence": 0.8}]}),
        ]
        facts = fe.extract_facts(prompt=self.prompt, structure=self.structure, llm="dummy")
        self.assertEqual(len(facts), 1)
        self.assertEqual(facts[0]["text"], "ok")

    @patch("fact_extractor.get_llm_response_from_context")
    def test_irrecoverable_json_returns_empty(self, mock_llm):
        mock_llm.side_effect = ["not json", "still not json"]
        facts = fe.extract_facts(prompt=self.prompt, structure=self.structure, llm="dummy")
        self.assertEqual(facts, [])


if __name__ == "__main__":
    unittest.main()

