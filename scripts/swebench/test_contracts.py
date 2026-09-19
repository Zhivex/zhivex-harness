import unittest
from common import compare_source_entries, CANDIDATES, public_task, select_tasks, summarize

class ComparisonTests(unittest.TestCase):
    def manifest(self):
        return {"tasks": [{"instance_id": "one"}, {"instance_id": "two"}], "repetitions": 2, "seed": 42}

    def samples(self):
        return [{"instanceId": task, "candidate": candidate, "repetition": repetition,
                 "resolved": candidate == "zhivex", "gradingStatus": "completed", "totalDurationMs": 10,
                 "usageComplete": True, "costUsd": 1}
                for task in ["one", "two"] for candidate in CANDIDATES for repetition in range(2)]

    def test_no_gold_or_test_data_in_driver_task(self):
        task = dict(instance_id="one", repo="org/repo", base_commit="a", problem_statement="Fix it",
                    patch="gold", test_patch="hidden", FAIL_TO_PASS=["hidden-name"], hints_text="hint")
        self.assertEqual(set(public_task(task)), {"instance_id", "repo", "base_commit", "problem_statement"})

    def test_selection_is_reproducible_independent_of_input_order(self):
        tasks = [{"instance_id": str(index)} for index in range(10)]
        self.assertEqual(select_tasks(tasks, 5, 42), select_tasks(list(reversed(tasks)), 5, 42))
        with self.assertRaises(ValueError):
            select_tasks(tasks + tasks[:1], 5, 42)

    def test_failures_remain_in_denominator_and_cost(self):
        rows = self.samples()
        rows[0]["resolved"] = False
        report = summarize(self.manifest(), rows)
        group = report["candidates"]["zhivex"]
        self.assertEqual(group["resolutionRate"], .75)
        self.assertEqual(group["totalCostUsd"], 4)
        self.assertAlmostEqual(group["costPerResolvedUsd"], 4 / 3)

    def test_unknown_cost_and_missing_runs_are_never_zero_cost(self):
        rows = self.samples()[1:]
        rows[0]["costUsd"] = None
        report = summarize(self.manifest(), rows)
        self.assertFalse(report["complete"])
        self.assertIsNone(report["pairedTaskBootstrap95"])
        self.assertIsNone(report["candidates"]["zhivex"]["totalCostUsd"])

    def test_duplicates_and_invalid_grading_are_rejected(self):
        rows = self.samples()
        with self.assertRaises(ValueError):
            summarize(self.manifest(), rows + rows[:1])
        rows[0]["resolved"] = "true"
        with self.assertRaises(ValueError):
            summarize(self.manifest(), rows)

    def test_image_mode_changes_cannot_hide_source_changes(self):
        self.assertEqual(compare_source_entries({"a": ("100755", "blob")}, {"a": ("100644", "blob")}), 1)
        with self.assertRaises(ValueError):
            compare_source_entries({"a": ("100755", "changed")}, {"a": ("100644", "blob")})
        with self.assertRaises(ValueError):
            compare_source_entries({"a": ("120000", "blob")}, {"a": ("100644", "blob")})

    def test_patch_policy_uses_git_parsing(self):
        from run import changed_paths, protected_path
        patch = "diff --git a/source.py b/source.py\n--- a/source.py\n+++ b/source.py\n@@ -1 +1 @@\n-old\n+new\n"
        self.assertEqual(changed_paths(patch), ["source.py"])
        self.assertTrue(protected_path("tests/hidden.py"))
        self.assertTrue(protected_path("setup.cfg"))
        self.assertFalse(protected_path("django/db/models/query_utils.py"))

    def test_repetitions_are_clustered_by_task(self):
        report = summarize(self.manifest(), self.samples())
        self.assertEqual(report["pairedTaskResolutionDifference"], 1)
        self.assertEqual(report["pairedTaskBootstrap95"], [1, 1])

if __name__ == "__main__":
    unittest.main()
