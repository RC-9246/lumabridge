# Development contract

- Keep code in this repository independently authored. Do not copy NapCat,
  SnowLuma, SnowCat or their native components without documented permission.
- Keep implemented, tested with mocks, and verified against real clients distinct.
- Never turn an unknown send result into success or automatically retry it.
- Keep account identities and backend generations explicit; do not silently switch
  the backend for an operation that may already have been submitted.
- Use synthetic data in tests. Never commit tokens, account data or local configs.
- No real QQ message, login, or production configuration changes during tests.
- Run `pnpm check` and `pnpm build` before publishing code changes.
- Update the documented milestone and limitations when behavior changes.
