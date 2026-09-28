"""仅检查样本边界，不加载模型、不测试识别准确率。"""
import unittest
from types import SimpleNamespace
import numpy as np
from engine import Segmenter, join_text


class FakeVad:
    def __init__(self, events):
        self.events = events
        self.frames = []

    def reset(self):
        self.frames = []

    def detect_frame(self, audio):
        self.frames.append(audio.copy())
        event = dict(is_speech_start=False, is_speech_end=False,
                     speech_start_frame=-1, speech_end_frame=-1)
        event.update(self.events.get(len(self.frames), {}))
        return SimpleNamespace(**event)


class SegmenterTest(unittest.TestCase):
    def test_chunk_boundaries_preserve_overlap_and_tail(self):
        audio = np.arange(1600, dtype=np.int16)
        vad = FakeVad({2: dict(is_speech_start=True, speech_start_frame=1)})
        segmenter = Segmenter(vad)
        result = []
        for chunk in np.array_split(audio, 7):
            result.extend(segmenter.feed(chunk.tobytes()))
        result.extend(segmenter.feed(b'', True))
        np.testing.assert_array_equal(result[0], audio)
        self.assertEqual([int(frame[0]) for frame in vad.frames], list(range(0, 1201, 160)))

    def test_forced_split_has_no_gap_or_duplicate(self):
        audio = np.arange(2400, dtype=np.int16)
        vad = FakeVad({1: dict(is_speech_start=True, speech_start_frame=1),
                       5: dict(is_speech_end=True, speech_end_frame=5),
                       6: dict(is_speech_start=True, speech_start_frame=6)})
        segmenter = Segmenter(vad)
        results = segmenter.feed(audio.tobytes(), True)
        self.assertEqual(len(results), 2)
        np.testing.assert_array_equal(np.concatenate(results), audio)

    def test_silence_is_not_sent_to_decoder(self):
        segmenter = Segmenter(FakeVad({}))
        self.assertEqual(segmenter.feed(bytes(32000), True), [])
        self.assertLessEqual(len(segmenter.audio), 4000)

    def test_intentional_repetitions_are_preserved(self):
        self.assertEqual(join_text(['再试一次。', '再试一次。']), '再试一次。再试一次。')
        self.assertEqual(join_text(['hello', 'world']), 'hello world')


if __name__ == '__main__':
    unittest.main()
