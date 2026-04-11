<!-- @format -->

# Idea Doc

I want to design a HTTP client such that:

- Everything is modular. Everything is a building block that can be combined, extended or replaced independently.
- Everything is extensible. You should be able to add new functionality without modifying the core.
- The footprint of the file setup in a repo is minimal and very straightforward / readable.
- AI and humans alike are able to use the HTTP client effectively, with clear and understandable interfaces.
- Secrets, environment variables, and configuration are handled securely and transparently, allowing for easy management and integration into different environments.

My motivation behind designing this solution is I want to test various changes to for example an API I'm working on and be able to do so in a way that is both flexible and maintainable. I have plenty of headers to switch between, different authentication methods to test, different body content to send, and different endpoints to hit. I have various requests I need to make some can be done in parallel others need to be sequential.
I would like to define a "run file" that specifies various blocks and their execution order, allowing me to easily configure and run different sets of HTTP requests in a structured and repeatable manner.
Often times, I'm using Claude Code or Github Copilot to implement code changes and part of the validation is running HTTP requests to ensure the changes work as expected. For this reason, they need to be able to be 'paused' and resumed, allowing for step-by-step execution and inspection of the requests and responses by Claude Code or Github Copilot acting as LLM-as-a-judge. Each response should be captured in an untracked file for easy inspection and comparison.

## Tech Notes

- Use a pnpm turborepo monorepo to manage everything. I've already started the scaffold for it so study it.
- App "apps" should live as `apps/` within the monorepo.
- Packages "packages" should live as `packages/` within the monorepo. Share as much code as possible between apps and packages to avoid duplication and promote reusability.
- Everything must be strictly typed.
- The `./testing/` directory should contain all test-related files and should be structured in a way that makes it easy to add new tests and understand existing ones. This is not just for actual test suites/files but also documents to be used by coding agents to validate and verify various flows and behaviors, acting as 'LLM-as-a-judge' during the testing process.
