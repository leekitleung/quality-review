# Evidence Source Validation

[34mℹ[0m Validating: round-050
[34mℹ[0m Diff files: 0
[34mℹ[0m Reviewers found: 2
[34mℹ[0m Reviewers: architecture-maintainer, product-flow


[36m═══════════════════════════════════════════════════[0m
[36m  Evidence Source Validation Report[0m
[36m═══════════════════════════════════════════════════[0m

[34mReviewer: architecture-maintainer[0m
  Evidence Quality:
    - File:Line references: 1 [31m(需要 ≥5)[0m
    - Command outputs: 1
    - Test results: 2
    - Claimed Score: 89/100
      [31m⚠️ 高分低证: 89分 仅 4 个证据[0m
  File Reference Verification:
    - Total refs: 1
    - [31m❌ 1 invalid refs[0m
  [31m❌ Violations (2):[0m
    - [candidate_identity_mismatch] reviewer packet 未绑定当前 candidate commit/tree
    - [invalid_file_reference] 引用了不存在的文件: review-runner.mjs:867

[34mReviewer: product-flow[0m
  Evidence Quality:
    - File:Line references: 0 [31m(需要 ≥5)[0m
    - Command outputs: 4
    - Test results: 1
    - Claimed Score: 88/100
  [31m❌ Violations (1):[0m
    - [candidate_identity_mismatch] reviewer packet 未绑定当前 candidate commit/tree

[36m───────────────────────────────────────────[0m
Summary:
  Reviewers: 2
  Passed: 0/2
  Total Violations: 3
  Total Warnings: 0

[31m❌ 3 violations found - review required[0m


