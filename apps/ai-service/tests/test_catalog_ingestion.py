"""Catalog ingestion (M8): pack/price parsing, the Jan Aushadhi and brand loaders, rejections, safety."""

import importlib.util
import sys
from argparse import Namespace
from datetime import date
from decimal import Decimal
from pathlib import Path

import pytest

from tests.catalog_support import ROOT, sources

_SPEC = importlib.util.spec_from_file_location(
    "seed_catalog", ROOT / "data" / "scripts" / "seed_catalog.py"
)
assert _SPEC and _SPEC.loader
sys.path.insert(0, str(ROOT / "data" / "scripts"))
seed = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(seed)

SEED = ROOT / "data" / "seed"


class TestPackAndPrice:
    @pytest.mark.parametrize(
        ("text", "form", "expected"),
        [
            ("10's", "tablet", (Decimal(10), "tablet")),
            ("10's", "capsule", (Decimal(10), "capsule")),
            ("10 Tablets", "tablet", (Decimal(10), "tablet")),
            ("15 Capsules", "capsule", (Decimal(15), "capsule")),
            ("60 ml", "syrup", (Decimal(60), "ml")),
            ("100 ml bottle", "suspension", (Decimal(100), "ml")),
            ("15 gm", "cream", (Decimal(15), "g")),
            ("1 vial", "injection", (Decimal(1), "vial")),
            ("1 pen", "injection", (Decimal(1), "vial")),
            ("strip of 10", "tablet", (None, None)),
            ("", "tablet", (None, None)),
            (None, "tablet", (None, None)),
            ("0's", "tablet", (None, None)),
        ],
    )
    def test_parse_pack(self, text, form, expected):
        assert sources.parse_pack(text, form) == expected

    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("12.50", Decimal("12.50")),
            ("₹ 1,250.00", Decimal("1250.00")),
            ("Rs. 30", Decimal("30")),
            ("0", None),
            ("", None),
            ("abc", None),
            (None, None),
        ],
    )
    def test_parse_money(self, text, expected):
        assert sources.parse_money(text) == expected

    def test_price_per_unit(self):
        assert sources.price_per_unit(Decimal(45), Decimal(15)) == Decimal("3.0000")
        assert sources.price_per_unit(Decimal(45), None) is None
        assert sources.price_per_unit(None, Decimal(15)) is None


class TestJanAushadhiLoader:
    def write(
        self,
        tmp_path: Path,
        rows: str,
        header: str = "Drug Code,Generic Name,Unit Size,MRP (in Rs.)",
    ) -> Path:
        (tmp_path / "list.csv").write_text(f"{header}\n{rows}", encoding="utf-8")
        return tmp_path

    def load(self, directory: Path):
        return sources.load_pmbjp(directory, date(2026, 1, 31), "PMBJP test list")

    def test_good_rows_become_priced_generic_records(self, tmp_path):
        result = self.load(self.write(tmp_path, '1,"Paracetamol Tablets IP 500 mg",10\'s,12.5\n'))
        (record,) = result.records
        assert (record.salt_key, record.strength_key, record.form_key, record.release_type) == (
            "paracetamol",
            "500mg",
            "tablet",
            "ir",
        )
        assert record.is_janaushadhi and record.is_generic and record.janaushadhi_code == "1"
        assert record.mrp == Decimal("12.5") and record.price_per_unit == Decimal("1.2500")
        assert record.price_source_date == date(2026, 1, 31) and record.source == "PMBJP test list"

    def test_rows_are_rejected_with_a_reason_never_guessed(self, tmp_path):
        rows = "\n".join(
            [
                '1,"Paracetamol Tablets IP 500 mg",10\'s,12.5',
                '2,"Paracetamol Tablets IP 500 mg",10\'s,',  # no price
                '3,"Paracetamol Tablets IP",10\'s,12',  # no strength
                '4,"Atorvastatin Tablets IP 10 mg",strip,15',  # no usable pack size
                '5,"Atorvastatin Tablets IP 10 mg",10\'s,90000000',  # absurd price
                ',"Cetirizine Tablets IP 10 mg",10\'s,5',  # no drug code
                '7,"Amoxycillin + Clavulanic Acid Tablets 625 mg",10\'s,60',  # one strength, two salts
            ]
        )
        result = self.load(self.write(tmp_path, rows + "\n"))
        assert len(result.records) == 1 and result.rows_read == 7
        assert dict(result.rejected) == {
            "missing_price_or_pack": 2,
            "composition_or_strength_unparseable": 2,
            "implausible_price": 1,
            "missing_name_or_code": 1,
        }
        assert all(len(v) <= 3 for v in result.examples.values())

    def test_header_names_are_matched_loosely(self, tmp_path):
        directory = self.write(
            tmp_path,
            '9,"Cetirizine Tablets IP 10 mg","10 tablets",5\n',
            "CODE,Name of Medicine,Pack Size,MRP",
        )
        assert len(self.load(directory).records) == 1

    def test_missing_columns_fail_loudly(self, tmp_path):
        directory = self.write(tmp_path, "1,2\n", "foo,bar")
        with pytest.raises(SystemExit):
            self.load(directory)


class TestLocalBrandLoader:
    def test_a_kaggle_style_file(self, tmp_path):
        path = tmp_path / "brands.csv"
        path.write_text(
            "name,price,manufacturer_name,pack_size_label,short_composition1\n"
            "Dolo 650 Tablet,31.5,Micro Labs,strip of 15 tablets,Paracetamol (650mg)\n"
            "Mystery Drug Tablet,10,Someone,strip of 10 tablets,Unknownium (5mg)\n"
            "Broken Tablet,abc,Someone,strip of 10 tablets,Paracetamol (500mg)\n",
            encoding="utf-8",
        )
        result = sources.load_local_brands(path, date(2026, 1, 1), "local test")
        assert result.rows_read == 3
        (dolo,) = [r for r in result.records if r.brand_name == "Dolo 650 Tablet"]
        assert (dolo.salt_key, dolo.strength_key, dolo.form_key) == (
            "paracetamol",
            "650mg",
            "tablet",
        )
        assert dolo.price_per_unit == Decimal("2.1000") and dolo.manufacturer == "Micro Labs"
        assert result.rejected["missing_price_or_pack"] == 1  # "Broken": the price is not a number
        assert result.rejected["composition_or_strength_unparseable"] == 1 or any(
            r.brand_name == "Mystery Drug Tablet" for r in result.records
        )

    def test_a_brand_with_no_recognisable_form_is_rejected(self, tmp_path):
        path = tmp_path / "brands.csv"
        path.write_text("name,price,composition\nXyz,10,Paracetamol (500mg)\n", encoding="utf-8")
        result = sources.load_local_brands(path, date(2026, 1, 1), "local test")
        assert not result.records and result.rejected["form_unknown"] == 1

    def test_the_brand_name_never_leaks_into_the_composition(self):
        assert sources.form_words("Dolo 650 Tablet") == "tablet"
        assert sources.form_words("Glycomet SR 500") is None  # no form word at all
        assert sources.form_words("", "Metformin SR Tablet") == "tablet SR"


class TestSeedFilesAndScript:
    def test_every_curated_brand_parses(self):
        result = sources.load_curated(SEED / "brands_curated.csv")
        assert result.rows_read == len(result.records) >= 70 and not result.rejected
        assert all(
            r.price_per_unit is None and r.mrp is None for r in result.records
        )  # never any price
        assert all("curated" in r.source for r in result.records)

    def test_the_fixture_is_fictional_and_labelled_so(self):
        result = sources.load_fixture(SEED / "fixture_catalog.csv")
        assert not result.rejected and len(result.records) >= 25
        assert {r.source for r in result.records} == {"test-fixture-fictional-prices"}

    def test_the_fixture_is_refused_in_production(self, monkeypatch):
        monkeypatch.setenv("NODE_ENV", "production")
        args = Namespace(
            pmbjp_dir="nonexistent",
            pmbjp_date=None,
            brands_csv=None,
            brands_date=None,
            fixture=True,
        )
        with pytest.raises(SystemExit, match="production"):
            seed.collect(args)

    def test_pmbjp_files_need_their_own_date(self, tmp_path):
        (tmp_path / "x.csv").write_text("Drug Code,Generic Name,Unit Size,MRP\n", encoding="utf-8")
        args = Namespace(
            pmbjp_dir=str(tmp_path),
            pmbjp_date=None,
            brands_csv=None,
            brands_date=None,
            fixture=False,
        )
        with pytest.raises(SystemExit, match="PMBJP_DATE"):
            seed.collect(args)

    def test_deduplication_is_by_source_and_reference(self):
        curated = sources.load_curated(SEED / "brands_curated.csv")
        records, duplicates = seed.dedupe([("a", curated), ("b", curated)])
        assert len(records) == len(curated.records) and duplicates == len(curated.records)

    def test_every_row_has_complete_keys(self):
        for result in (
            sources.load_curated(SEED / "brands_curated.csv"),
            sources.load_fixture(SEED / "fixture_catalog.csv"),
        ):
            for r in result.records:
                assert (
                    r.brand_key and r.salt_key and r.strength_key and r.form_key and r.release_type
                )
                assert r.salt_key == "+".join(sorted(r.salt_key.split("+")))
