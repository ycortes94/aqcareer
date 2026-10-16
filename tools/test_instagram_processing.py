"""Regression checks for the locked image-library upgrade; no network access."""
import io
from pathlib import Path
import tempfile
import unittest
from PIL import Image
from refresh_instagram import save_square_jpeg

class InstagramProcessing(unittest.TestCase):
    def test_rgb_and_transparent_sources(self):
        with tempfile.TemporaryDirectory() as temp:
            for mode, fmt in [('RGB', 'JPEG'), ('RGBA', 'PNG')]:
                with self.subTest(source=fmt):
                    data = io.BytesIO()
                    Image.new(mode, (120, 80)).save(data, format=fmt)
                    output = Path(temp) / 'poster.jpg'
                    save_square_jpeg(data.getvalue(), output)
                    with Image.open(output) as image:
                        self.assertEqual(image.size, (640, 640))
                        self.assertEqual(image.mode, 'RGB')
                        self.assertEqual(image.format, 'JPEG')
    def test_invalid_download_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):
                save_square_jpeg(b'<html>not an image</html>', Path(temp) / 'bad.jpg')

if __name__ == '__main__': unittest.main()
