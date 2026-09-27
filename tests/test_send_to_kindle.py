import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import app
from app import (
    build_kindle_message,
    env_locked_config_keys,
    load_config,
    normalize_email_list,
    normalize_kindle_formats,
    normalize_smtp_security,
    save_config,
    select_kindle_attachments,
)


class NormalizeEmailListTests(unittest.TestCase):
    def test_splits_on_commas_spaces_and_newlines(self):
        result = normalize_email_list("a@kindle.com, b@kindle.com\nc@kindle.com d@kindle.com")

        self.assertEqual(result, ["a@kindle.com", "b@kindle.com", "c@kindle.com", "d@kindle.com"])

    def test_drops_invalid_addresses(self):
        self.assertEqual(normalize_email_list("nope, also@bad, good@kindle.com"), ["good@kindle.com"])

    def test_dedupes_case_insensitively_keeping_first_spelling(self):
        self.assertEqual(normalize_email_list("Me@Kindle.com, me@kindle.com"), ["Me@Kindle.com"])

    def test_accepts_a_list_and_strips_angle_brackets(self):
        self.assertEqual(normalize_email_list(["<me@kindle.com>", ""]), ["me@kindle.com"])


class NormalizeKindleFormatsTests(unittest.TestCase):
    def test_normalizes_case_dots_and_separators(self):
        self.assertEqual(normalize_kindle_formats(".EPUB, azw3;mobi"), ["epub", "azw3", "mobi"])

    def test_preserves_preference_order_and_dedupes(self):
        self.assertEqual(normalize_kindle_formats(["pdf", "epub", "pdf"]), ["pdf", "epub"])

    def test_empty_value_returns_empty_list(self):
        self.assertEqual(normalize_kindle_formats(""), [])


class NormalizeSmtpSecurityTests(unittest.TestCase):
    def test_known_aliases(self):
        self.assertEqual(normalize_smtp_security("SSL"), "ssl")
        self.assertEqual(normalize_smtp_security("smtps"), "ssl")
        self.assertEqual(normalize_smtp_security("none"), "none")
        self.assertEqual(normalize_smtp_security("starttls"), "starttls")

    def test_blank_and_unknown_default_to_starttls(self):
        self.assertEqual(normalize_smtp_security(""), "starttls")
        self.assertEqual(normalize_smtp_security(None), "starttls")
        self.assertEqual(normalize_smtp_security("weird"), "starttls")


class SelectKindleAttachmentsTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, relative_path, size=1024):
        path = self.root / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * size)
        return path

    def test_prefers_the_first_configured_format_for_the_same_book(self):
        self.write("Book.mobi")
        expected = self.write("Book.epub")

        selected, skipped = select_kindle_attachments(self.root, ["epub", "mobi"])

        self.assertEqual(selected, [expected])
        self.assertEqual(skipped, [])

    def test_ignores_non_document_files(self):
        self.write("Book/audio.m4b")
        self.write("Book/cover.jpg")

        selected, skipped = select_kindle_attachments(self.root, ["epub"])

        self.assertEqual(selected, [])
        self.assertEqual(skipped, [])

    def test_reports_files_over_the_size_limit_instead_of_sending_them(self):
        oversize = self.write("Huge.epub", size=2048)

        selected, skipped = select_kindle_attachments(self.root, ["epub"], max_bytes=1024)

        self.assertEqual(selected, [])
        self.assertEqual([path for path, _ in skipped], [oversize])

    def test_falls_back_to_a_smaller_alternate_format(self):
        self.write("Book.epub", size=4096)
        small_pdf = self.write("Book.pdf", size=512)

        selected, _ = select_kindle_attachments(self.root, ["epub", "pdf"], max_bytes=1024)

        self.assertEqual(selected, [small_pdf])

    def test_caps_the_number_of_files_from_a_book_pack(self):
        for index in range(5):
            self.write(f"Book {index}.epub")

        selected, _ = select_kindle_attachments(self.root, ["epub"], max_files=2)

        self.assertEqual([path.name for path in selected], ["Book 0.epub", "Book 1.epub"])

    def test_accepts_a_single_file_download(self):
        single = self.write("Book.epub")

        selected, _ = select_kindle_attachments(single, ["epub"])

        self.assertEqual(selected, [single])

    def test_missing_path_or_no_formats_selects_nothing(self):
        self.write("Book.epub")

        self.assertEqual(select_kindle_attachments(self.root, []), ([], []))
        self.assertEqual(select_kindle_attachments(self.root / "missing", ["epub"]), ([], []))


class BuildKindleMessageTests(unittest.TestCase):
    SETTINGS = {
        "from_address": "sender@example.com",
        "recipients": ["a@kindle.com", "b@kindle.com"],
    }

    def test_attaches_the_file_with_its_own_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            book = Path(tmp) / "A Book.epub"
            book.write_bytes(b"epub-bytes")

            message = build_kindle_message(
                self.SETTINGS,
                subject="A Book - An Author",
                body="Sent by MouseSearch: A Book.epub",
                attachment=book,
            )

        self.assertEqual(message["To"], "a@kindle.com, b@kindle.com")
        self.assertEqual(message["Subject"], "A Book - An Author")
        attachments = list(message.iter_attachments())
        self.assertEqual(len(attachments), 1)
        self.assertEqual(attachments[0].get_filename(), "A Book.epub")
        self.assertEqual(attachments[0].get_content_type(), "application/epub+zip")
        self.assertEqual(attachments[0].get_payload(decode=True), b"epub-bytes")

    def test_works_without_an_attachment(self):
        message = build_kindle_message(self.SETTINGS, subject="Test", body="Hello")

        self.assertEqual(list(message.iter_attachments()), [])
        self.assertEqual(message.get_content().strip(), "Hello")


class EnvLockedSettingsTests(unittest.TestCase):
    """Mail settings from the environment win over config.json and stay out of it."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.config_file = Path(self._tmp.name) / "config.json"
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.object(app, "CONFIG_FILE", self.config_file)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_only_kindle_keys_present_in_the_environment_are_locked(self):
        with mock.patch.dict(os.environ, {"SEND_TO_KINDLE_SMTP_HOST": "smtp.example.com"}, clear=False):
            locked = env_locked_config_keys()

        self.assertIn("SEND_TO_KINDLE_SMTP_HOST", locked)
        self.assertNotIn("SEND_TO_KINDLE_SMTP_PASSWORD", locked)
        self.assertNotIn("MAM_ID", locked)

    def test_locked_keys_are_not_written_to_config_json(self):
        with mock.patch.dict(os.environ, {"SEND_TO_KINDLE_SMTP_PASSWORD": "app-password"}, clear=False):
            save_config({
                "MAM_ID": "mam-cookie",
                "SEND_TO_KINDLE_SMTP_PASSWORD": "app-password",
                "SEND_TO_KINDLE_SMTP_HOST": "smtp.example.com",
            })

        stored = json.loads(self.config_file.read_text())
        self.assertNotIn("SEND_TO_KINDLE_SMTP_PASSWORD", stored)
        self.assertEqual(stored["SEND_TO_KINDLE_SMTP_HOST"], "smtp.example.com")
        self.assertEqual(stored["MAM_ID"], "mam-cookie")

    def test_a_stale_config_json_value_cannot_shadow_the_environment(self):
        self.config_file.write_text(json.dumps({
            "SEND_TO_KINDLE_ENABLED": False,
            "SEND_TO_KINDLE_SMTP_HOST": "",
            "SEND_TO_KINDLE_MAX_ATTACHMENT_MB": 49.0,
        }))
        environment = {
            "SEND_TO_KINDLE_ENABLED": "true",
            "SEND_TO_KINDLE_SMTP_HOST": "smtp.example.com",
            "SEND_TO_KINDLE_MAX_ATTACHMENT_MB": "24",
        }

        with mock.patch.dict(os.environ, environment, clear=False):
            config = load_config()

        self.assertIs(config["SEND_TO_KINDLE_ENABLED"], True)
        self.assertEqual(config["SEND_TO_KINDLE_SMTP_HOST"], "smtp.example.com")
        self.assertEqual(config["SEND_TO_KINDLE_MAX_ATTACHMENT_MB"], 24.0)

    def test_config_json_still_wins_when_the_environment_is_silent(self):
        self.config_file.write_text(json.dumps({"SEND_TO_KINDLE_SMTP_HOST": "smtp.saved.example"}))

        config = load_config()

        self.assertEqual(config["SEND_TO_KINDLE_SMTP_HOST"], "smtp.saved.example")


if __name__ == "__main__":
    unittest.main()
