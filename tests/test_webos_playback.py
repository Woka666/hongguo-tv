import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/verify_webos_simulator_playback.py'


class WebosPlaybackVerification(unittest.TestCase):
    def report(self):
        steps = []
        for stage, time in [('episode-1-a', 3), ('episode-1-b', 7),
                            ('episode-1-seek', 18), ('episode-2-a', 3), ('episode-2-b', 7)]:
            steps.append(dict(stage=stage, currentTime=time, episode1Source=stage.startswith('episode-1'),
                              episode2Source=stage.startswith('episode-2'), seeking=False,
                              videoWidth=720, videoHeight=1280, decodedFrames=120, mediaError=0,
                              visible=True, loading=False, muted=False))
        return dict(platform='webOS TV 26 Simulator', redacted=True, accountStubbed=True,
                    ok=True, stage='passed', steps=steps,
                    requests=[dict(endpoint='play/info', status=200, ok=True, **{episode: True})
                              for episode in ('episode1', 'episode2')])

    def verify(self, report):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'report.json'
            file.write_text(json.dumps(report))
            return subprocess.run([sys.executable, str(SCRIPT), str(file)], capture_output=True, text=True)

    def test_visible_unmuted_playback_passes(self):
        self.assertEqual(self.verify(self.report()).returncode, 0)

    def test_background_playback_cannot_pass_as_visible_playback(self):
        for field, value in [('visible', False), ('loading', True), ('muted', True)]:
            with self.subTest(field=field):
                report = self.report()
                report['steps'][-1][field] = value
                self.assertNotEqual(self.verify(report).returncode, 0)

    def test_missing_presentation_evidence_fails(self):
        report = copy.deepcopy(self.report())
        for field in ('visible', 'loading', 'muted'):
            del report['steps'][-1][field]
        self.assertNotEqual(self.verify(report).returncode, 0)


if __name__ == '__main__':
    unittest.main()
