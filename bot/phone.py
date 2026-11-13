from __future__ import annotations

from dataclasses import dataclass

import phonenumbers


@dataclass(frozen=True)
class ParsedPhone:
    e164: str          # +34612345678
    region: str | None  # ES, MX, ...
    valid: bool        # прошёл ли номер проверку libphonenumber


def parse_phone(raw: str) -> ParsedPhone | None:
    """Telegram отдаёт номер цифрами, часто без '+'. Приводим к E.164."""
    digits = "".join(ch for ch in raw if ch.isdigit())
    if not 7 <= len(digits) <= 15:
        return None
    try:
        num = phonenumbers.parse("+" + digits, None)
    except phonenumbers.NumberParseException:
        return None
    return ParsedPhone(
        e164=phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164),
        region=phonenumbers.region_code_for_number(num),
        valid=phonenumbers.is_valid_number(num),
    )
