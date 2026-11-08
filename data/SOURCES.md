# Catalog data sources (M8)

Every row in `drugs` carries its source in `drugs.source`, and every price its `price_source_date`.
**No licence below has been verified by us.** The official sites are JavaScript-rendered and could
not be read automatically, and no licence text was found by search. Check each source's terms
yourself before relying on it, and before any public deployment. Raw files live in `data/raw/`
(gitignored); only scripts and small fixtures are committed.

| # | Source | What it contains | Format / update | Licence / terms | How we use it | Status |
|---|---|---|---|---|---|---|
| 1 | **Jan Aushadhi (PMBJP) product list**, run by PMBI. Official: pmbi.co.in, janaushadhi.gov.in | Drug code, generic name (strength inside the name text), unit size, MRP | PDF/Excel, updated when products are added (2,110 products as of 31.12.2025 per a PIB annexure) | **Unverified.** An official government body; no licence text found | The only source of generic alternatives and prices. You export it to CSV (`Drug Code, Generic Name, Unit Size, MRP`) into `data/raw/pmbjp/`, then `make seed PMBJP_DATE=YYYY-MM-DD`. Strength and form are PARSED from the name; rows that cannot be parsed are rejected and counted in `data/reports/` | **Not ingested yet: the file was not available.** Loader and parser are tested on a generated sample only, never on the real file |
| 2 | **NPPA ceiling prices** (DPCO 2013, Schedule I) | Scheduled formulation, strength, unit, ceiling price | PDF/Excel on the NPPA site, revised yearly | **Unverified.** If published on data.gov.in it would fall under GODL-India (reportedly commercial use allowed with attribution); not confirmed | Planned only as a price sanity check (a ceiling is a cap, not an MRP) | **Not built in M8**: it needs the file and only sanity-checks prices |
| 3 | **Brand datasets** (Kaggle "A-Z medicine dataset of India", `junioralive/Indian-Medicine-Dataset`, scraped 1mg sets ...) | Brand, manufacturer, composition, pack, price | CSV, updated about yearly; prices are volatile | **No licence found for any of them.** Some are scraped from a commercial site | **Never committed or redistributed.** You may load one LOCALLY: `make seed BRANDS_CSV=data/raw/brands.csv` (gitignored). Rows without a parseable form, composition or price are rejected | Optional, local only |
| 4 | **CDSCO approved drugs list** | Salt names | PDFs | **Not researched** | Could help review the salt-alias list | Not used |
| 5 | **Our curated brand list** `data/seed/brands_curated.csv` | 73 common brands: brand, composition with strengths, form. **No prices** | CSV in the repo | Our own content, written from general pharmacy knowledge | The brand -> salt/strength/form mapping that makes matching work without a licensed brand dataset | **UNREVIEWED: a pharmacist must check every row before launch.** `drugs.source` says so |
| 6 | **Fixture with FICTIONAL prices** `data/seed/fixture_catalog.csv` | 13 Jan-Aushadhi-style generics and 15 brands with made-up round prices | CSV in the repo | Ours | Tests, the evals and `make seed FIXTURE=1` for a local demo. **Refused when `NODE_ENV=production`.** Its prices are invented and must never be shown to real users | Test/demo only |

## The honest gap

There is no brand dataset with a verified licence. Consequences:

* Brand -> salt matching works from the curated list (about 73 brands) plus anything you load locally.
  A brand that is not in the loaded catalog is shown from the prescription alone, without catalog data.
* **Brand prices are unknown** for the curated brands. The bot therefore never says an alternative is
  "cheaper" and never shows a saving unless BOTH the brand price and the alternative's price are in the
  catalog (for example from a local brand CSV). Otherwise it says "a generic with the same salt is
  available" and shows the Jan Aushadhi price.
* Until the real Jan Aushadhi list is loaded there are no generic alternatives at all.
* Prices are approximate MRPs from the date shown (`price_source_date`) and go stale. Re-run `make seed`
  with a fresh list; the upsert is idempotent per `(source, source_ref)`.

# Interaction data sources (M11)

**Licences below were NOT verified by us** (no terms page was opened; written from memory, so treat
every cell as "check before relying"). The approved decision (2026-11-08): the only ingested source is
our own **curated core list**, backed by public drug labels and the ONC list as citations. DDInter and
DrugBank are NOT used.

| # | Source | Content | Format / update | Licence / terms (unverified) | How we use it | Status |
|---|---|---|---|---|---|---|
| 1 | **Curated core list** `data/seed/interactions_core.csv` + `interaction_classes.csv` | 89 rows (class macros such as `@nsaid`, `@anticoagulant` expand to the 796+ stored pairs): pair, severity, effect code, mechanism, citation per row | CSV in the repo | Our own content (facts re-worded, no text copied) | The ONLY interaction source in `interactions` (`source` = "Dawai Saathi curated list from drug labels (pharmacist review pending)", `source_version` = `core-v1`) | **UNREVIEWED by a pharmacist or doctor. Citations are general ("FDA/DailyMed <drug> label, Drug Interactions section"), written from memory and NOT checked against the label text.** Coverage is PARTIAL |
| 2 | **DDInter 2.0** (Central South University) | Pairs with Major / Moderate / Minor | CSV downloads | Reportedly CC BY-NC-SA 4.0 or similar academic terms: non-commercial and share-alike would conflict with a commercial launch | Not used | Not ingested. Needs a terms check first, then a separate `source` value so it can be removed cleanly |
| 3 | **ONC High-Priority DDI list** (Phansalkar et al., JAMIA 2012) | About 15 high-priority pairs/classes, US-centric | Journal article, no machine-readable file | Journal copyright; facts are not copyrightable but wording is | Cited as background for a few rows; no text copied | Static (2012) |
| 4 | **openFDA / DailyMed drug labels** | Free-text "Drug Interactions" sections | JSON API | Public domain per openFDA, with a disclaimer | Reference for checking the core list; no automatic pair extraction | **Not yet used for checking: a reviewer should compare each row with its label** |
| 5 | **DrugBank** | Most complete | XML/CSV | Free for non-commercial academic use only; commercial licence needed | **Not used** | Needs your confirmation and a licence |
| 6 | **RxNav / NLM Interaction API** | n/a | n/a | Discontinued in 2024 | Not an option | n/a |

## Honest gaps

* Coverage is **partial**. A pair with no row is "not found in our list", never "safe": the bot says so
  every time (`app/interactions/render.py`, enforced by the verifier and the eval).
* The checker works on the **salt** of a medicine. A medicine is only checked when its salt is certain:
  a confident catalog match, a brand-name prefix ("Dolo" for Dolo 650), or a name that is exactly a salt
  the interaction table knows ("Warfarin"). Everything else is reported as "could not be checked".
  The curated brand list has only 73 brands, so many Indian brand names are NOT checkable until the
  catalog grows (see the list of salts without a product in `data/reports/<date>-interactions.md`).
* Hindi text: effect sentences (`app/interactions/effects.py`) and management lines are written by us
  and have to be reviewed (`data/review/interaction_effects_hi_review.csv`,
  `data/review/interactions_hi_review.csv`). Until a row is reviewed its Hindi management line is the
  generic "ask your doctor or pharmacist" sentence (`interactions.hi_reviewed = false`).
* `aspirin x clopidogrel` is stored as **minor** because doctors prescribe it together on purpose; it
  appears in the details view and in a typed question, not in a prescription reply.
* Updating the data: edit the CSV, `make seed` (idempotent; rows of this source that disappeared from
  the CSV are removed), re-run `make eval-interactions`.

## Download log

| Dataset | Downloaded | By | Note |
|---|---|---|---|
| (none yet) | | | Add a row for every file placed in `data/raw/`: name, URL, date, who, licence terms seen |
