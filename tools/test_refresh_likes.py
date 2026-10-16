"""Saved-chart refresh contract: overall counts and safe failure on bad exports."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import refresh_likes as likes


class SavedChartLikes(unittest.TestCase):
    def test_csv_export_through_http_json_wrapper(self):
        # Real export layout, entirely synthetic names and counts.
        source = '''"\tExample chart"

"\tFormula","\tUNIQUES(A)-UNIQUES(B);UNIQUES(A);UNIQUES(B)"
"\tA:","\tpost_liked","\tpost","\tlabs_pinned is not ""true"""
"\tB:","\tpost_unliked","\tpost","\tlabs_pinned is not ""true"""

"\tFormula","\tpost","\tpost","\t2023-11-01 to 2026-10-01"
"\tFormula A: UNIQUES(A)-UNIQUES(B)","\texample-post-a","\t","0.0"
"\tFormula B: UNIQUES(A)","\texample-post-a","\t","3"
"\tFormula C: UNIQUES(B)","\t","\texample-post-a","3"
"\tFormula A: UNIQUES(A)-UNIQUES(B)","\texample-post-b","\t","5.0"
"\tFormula B: UNIQUES(A)","\texample-post-b","\t","5"
'''
        response = contextlib.closing(io.BytesIO(json.dumps({"data": source}).encode()))
        with patch.object(likes.urllib.request, "urlopen", return_value=response):
            payload = likes.fetch("https://amplitude.com/api/3/chart/pojjnh8i/csv",
                                  "test", "test")
        result = likes.counts_from(payload)
        self.assertEqual(result, {"example-post-a": 0, "example-post-b": 5})

    def test_csv_rejects_time_series_and_bad_counts(self):
        header = 'Formula,post,post,2023-11-01 to 2026-10-01\n'
        valid_row = 'Formula B: UNIQUES(A),post-a,,2\n'
        cases = ["not a chart", header + valid_row.replace(',2', ',NaN'),
                 header + valid_row.replace(',2', ',1.5'),
                 header + valid_row.replace(',2', ',true'),
                 header + valid_row.replace('post-a,,', 'post-a,post-b,'),
                 header + valid_row.rstrip() + ',3\n',
                 'Formula,post,2026-09-01,2026-10-01\nFormula B: UNIQUES(A),post-a,2,3\n']
        for source in cases:
            with self.subTest(source=source), self.assertRaises(SystemExit):
                likes.counts_from({"data": source})

    def test_components_keep_posts_with_no_unlikes(self):
        # seriesMeta and seriesCollapsed shape observed in the live chart.
        entries = [("post-a", "UNIQUES(A)-UNIQUES(B)", 0),
                   ("post-a", "UNIQUES(A)", 1),
                   ("post-a", "UNIQUES(B)", 1),
                   ("post-b", "UNIQUES(A)", 2)]
        payload = {"data": {
            "seriesMeta": [{"segmentIndex": 0, "eventGroupBys": [slug],
                            "formula": formula} for slug, formula, _ in entries],
            "seriesCollapsed": [[{"value": value}] for _, _, value in entries],
        }}
        self.assertEqual(likes.counts_from(payload), {"post-a": 0, "post-b": 2})
        payload["data"]["seriesCollapsed"][0][0]["value"] = 3
        with self.assertRaises(SystemExit):
            likes.counts_from(payload)

    def test_overall_counts_not_monthly_sum(self):
        payload = {"data": {
            "seriesLabels": [["net likes", "post-a"], "post-b"],
            "seriesCollapsed": [[{"value": 3}], [{"value": -1}]],
            "series": [[3, 3], [1, 1]],
        }}
        self.assertEqual(likes.net_likes(likes.counts_from(payload), {},
                                        ["post-a", "post-b", "post-c"]),
                         {"post-a": 3, "post-b": 0, "post-c": 0})

    def test_bad_chart_exports_preserve_published_counts(self):
        cases = [{}, {"data": {}}, {"data": {
            "seriesLabels": ["post-a"], "seriesCollapsed": []}}]
        for values in ([3.5], [None], [True], [float("nan")], [1, 2]):
            cases.append({"data": {"seriesLabels": ["post-a"],
                "seriesCollapsed": [[{"value": v} for v in values]]}})
        cases.append({"data": {"seriesLabels": ["post-a", "post-a"],
            "seriesCollapsed": [[{"value": 3}], [{"value": 1}]]}})
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp) / "likes.json"
            target.write_text('{"post-a": 7}\n')
            source = Path(temp) / "response.json"
            for payload in cases:
                with self.subTest(payload=payload):
                    source.write_text(json.dumps(payload))
                    with patch.object(likes, "LIKES", str(target)), \
                         patch.object(likes, "slugs", return_value=["post-a"]), \
                         patch.dict(likes.os.environ, {"AMPLITUDE_START": ""}):
                        with self.assertRaises(SystemExit):
                            likes.main(["--from", str(source)])
                    self.assertEqual(target.read_text(), '{"post-a": 7}\n')

    def test_refresh_fetches_saved_chart(self):
        payload = {"data": {"seriesLabels": ["post-a"],
                            "seriesCollapsed": [[{"value": 2}]]}}
        with patch.dict(likes.os.environ, {"AMPLITUDE_API_KEY": "test",
                "AMPLITUDE_SECRET_KEY": "test", "AMPLITUDE_REGION": "us",
                "AMPLITUDE_START": ""}), \
             patch.object(likes, "slugs", return_value=["post-a"]), \
             patch.object(likes, "read_current", return_value={"post-a": 1}), \
             patch.object(likes, "fetch", return_value=payload) as fetch, \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(likes.main(["--dry-run"]), 0)
            self.assertEqual(fetch.call_args.args[0],
                             likes.chart_url(likes.REGIONS["us"]))
            self.assertIn("/api/3/chart/", fetch.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
