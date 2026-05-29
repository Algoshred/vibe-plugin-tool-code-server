# @vibecontrols/vibe-plugin-tool-code-server

<!-- VIBECONTROLS_OSS_BODY_START -->

> Browser-based VS Code via code-server — reverse-proxied through the VibeControls agent.

## Install

```bash
vibe plugin install @vibecontrols/vibe-plugin-tool-code-server
```

Or install the npm package directly into an existing project that hosts the VibeControls agent:

```bash
bun add @vibecontrols/vibe-plugin-tool-code-server
# or
npm install @vibecontrols/vibe-plugin-tool-code-server
```

## How it works

**Tool** plugins surface a single capability on the agent's REST surface and (where applicable) an iframe-mounted UI. They run independently of any meta plugin.

## Upstream

- **code-server** — <https://github.com/coder/code-server>

## More

- npm: <https://www.npmjs.com/package/@vibecontrols/vibe-plugin-tool-code-server>
- Source: <https://github.com/algoshred/vibe-plugin-tool-code-server>
- Plugin contract / SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- Plugin catalogue: <https://vibecontrols.com/plugins/tool-code-server>

<!-- VIBECONTROLS_OSS_BODY_END -->

<!-- VIBECONTROLS_OSS_FOOTER_START -->

---

## About VibeControls

**VibeControls** is the agentic engineering mission control for AI-native teams. Vibe-plugins extend the VibeControls agent with new providers, tools, sessions, tunnels, storage backends, and security stages.

- Website: <https://vibecontrols.com>
- Documentation: <https://docs.vibecontrols.com>
- Plugin SDK: <https://github.com/algoshred/vibecontrols-plugin-sdk>
- All plugins: <https://github.com/algoshred?q=vibe-plugin-&type=all>

## Credits

This plugin builds on the following upstream open-source projects. All trademarks and copyrights remain with their respective owners.

- **code-server** — <https://github.com/coder/code-server>

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 Burdenoff Consultancy Services Private Limited, Algoshred Technologies Private Limited, and all its sister companies.

Maintainer: **Vignesh T.V** — <https://github.com/tvvignesh>

**Note**: this plugin is open source under MIT. The `@vibecontrols/agent` runtime that loads and orchestrates plugins is **closed source** and proprietary to Burdenoff Consultancy Services Pvt. Ltd. If you want a fully self-hostable agent, please open an issue or contact the maintainer.

<!-- VIBECONTROLS_OSS_FOOTER_END -->
