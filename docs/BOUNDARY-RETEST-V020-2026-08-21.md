# v0.2.0 boundary-verification retest — 2026-08-21

The failed `feature-py` case was corrected by strengthening the verifier contract and role instructions.

| Metric | Result |
|---|---:|
| Real Thearchy reruns | 3/3 completed |
| Tests passed | 3/3 |
| Boundary checks | 45/45 |
| `bool` vs `int` checks | 6/6 |
| Regressions | 0 |
| Child agents | 2 per run |

Each repetition used a fresh implementation Agent and a separate independent tester. The tester explicitly checked `True`, `False`, zero, negative values, `None`, strings, floats, valid integers, threshold transitions, reset/unlock behavior, expiry boundaries, account isolation, and legacy compatibility.

The targeted regression gate passed. A complete post-hardening rerun of every affected feature, bug-fix, and migration case is still required before the stable release gate can be changed from failed to passed.
