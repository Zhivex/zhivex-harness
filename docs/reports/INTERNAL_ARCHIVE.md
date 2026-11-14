# Internal report archive

On 2026-11-13, thirteen historical UX, candidate-preparation and HU tracking narratives moved to the [private Notion archive](https://app.notion.com/p/418777b104f681959506f9aba73e2b12?pvs=204). Notion access is required. Their original statuses remain historical; this migration changes no acceptance or publication outcome.

The complete originals remain in Git at `a87499d4cd78ae5edcf18c22f2e97f9828e8099f`. Technical references in maintained guides point to those immutable source files so reading evidence does not require Notion. All existing report JSON, benchmark baselines, tests, contracts, final campaigns and publication evidence remain in the checkout.

| Original report | Internal narrative | Frozen technical record |
| --- | --- | --- |
| `ASSISTANT_MERGE_READINESS_2026-11-11.md` | [Notion](https://app.notion.com/p/418777b104f681febb18e5f53f9ffbe8?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/ASSISTANT_MERGE_READINESS_2026-11-11.md) |
| `CODE_0_2_0_READINESS_2026-10-03.md` | [Notion](https://app.notion.com/p/418777b104f6819ead0ec52091f77b7c?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/CODE_0_2_0_READINESS_2026-10-03.md) |
| `RELEASE_1_6_3_CODE_0_4_2.md` | [Notion](https://app.notion.com/p/418777b104f68195ab2dfea4c33fd3ca?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/RELEASE_1_6_3_CODE_0_4_2.md) |
| `CODE_COMPACT_FLOW.md` | [Notion](https://app.notion.com/p/418777b104f6813bb98cd8c2b785a3b6?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/CODE_COMPACT_FLOW.md) |
| `WEB_FLOW_AUDIT.md` | [Notion](https://app.notion.com/p/418777b104f681659836e83a2be180d7?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/WEB_FLOW_AUDIT.md) |
| `WEB_LIMITS_DESIGN_QA.md` | [Notion](https://app.notion.com/p/418777b104f6819b931dce4effa4dac4?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/WEB_LIMITS_DESIGN_QA.md) |
| `assistant-settings/design-qa.md` | [Notion](https://app.notion.com/p/418777b104f681c58971efcc534ead2b?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/assistant-settings/design-qa.md) |
| `HAR_HU_12_2026-09-20.md` | [Notion](https://app.notion.com/p/418777b104f68153922bdcd74dde13f0?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_12_2026-09-20.md) |
| `HAR_HU_37_38_2026-09-28.md` | [Notion](https://app.notion.com/p/418777b104f681b49c52e072853f57f0?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_37_38_2026-09-28.md) |
| `HAR_HU_39_2026-09-29.md` | [Notion](https://app.notion.com/p/418777b104f68197928ec71c735d57d5?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_39_2026-09-29.md) |
| `HAR_HU_41_44_2026-09-28.md` | [Notion](https://app.notion.com/p/418777b104f681738200df1905416f2b?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_41_44_2026-09-28.md) |
| `HAR_HU_42_2026-09-29.md` | [Notion](https://app.notion.com/p/418777b104f681e39946d8448b19c7ea?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_42_2026-09-29.md) |
| `HAR_HU_51_2026-09-29.md` | [Notion](https://app.notion.com/p/418777b104f681a882e6e8d99cb6b48f?pvs=204) | [Original](https://github.com/Zhivex/zhivex-harness/blob/a87499d4cd78ae5edcf18c22f2e97f9828e8099f/docs/reports/HAR_HU_51_2026-09-29.md) |

## Integrity and recovery

[Migration manifest](internal-archive-2026-11-13.json) records the original path, SHA-256, source commit and Notion destination for every report. The Markdown in Notion retains the complete narrative with relative links resolved against the source commit; formatting is normalized by Notion.

Recover an original without Notion or GitHub access from a clone containing the source commit:

```sh
git show a87499d4cd78ae5edcf18c22f2e97f9828e8099f:docs/reports/HAR_HU_39_2026-09-29.md
```

References to `/tmp` logs and screenshots remain historical references; this migration does not recover or upload those transient files. The source records and their limitations are preserved.
