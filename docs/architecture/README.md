# Architecture diagrams

[Architecture](../../ARCHITECTURE.md) owns implementation structure and trust boundaries. Diagrams show the local viewer, optional SDK workflows, isolated coding pilot and separate scripted experiment.

The [sandbox validation report](../SANDBOX_VALIDATION.md) records observed live-run,
final-executor, control-test and dashboard-persistence results. Use it to distinguish
tested behavior from the implementation structure shown in these diagrams.

| View | Rendered | Editable |
| --- | --- | --- |
| System overview | [SVG](diagrams/system-overview.svg) | [Mermaid](diagrams/system-overview.mmd) |
| C4 context | [SVG](diagrams/c4-context.svg) | [Mermaid](diagrams/c4-context.mmd) |
| C4 containers | [SVG](diagrams/c4-containers.svg) | [Mermaid](diagrams/c4-containers.mmd) |
| C4 browser components | [SVG](diagrams/c4-components.svg) | [Mermaid](diagrams/c4-components.mmd) |
| Agent workflow sequence | [SVG](diagrams/agent-workflow.svg) | [Mermaid](diagrams/agent-workflow.mmd) |
| Sandboxed coding sequence | [SVG](diagrams/sandbox-workflow.svg) | [Mermaid](diagrams/sandbox-workflow.mmd) |

C4 levels follow the [official model](https://c4model.com/diagrams). Containers are runnable applications or data stores, not Docker units. Credential configuration and artifact files are distinct from browser-local saved evidence. C4 container/component views show the origin-scoped localStorage boundary. The experiment emits bare offline evaluator input; the SDK emits the envelope accepted by the browser.

The C4 views use explicit element types and Mermaid flowchart layout. Mermaid's dedicated [C4 syntax](https://mermaid.js.org/syntax/c4.html) is experimental; typed flowchart routing keeps relationship labels readable. SVGs use native text without embedded HTML or external resources.

Edit `.mmd`, regenerate `.svg`, and visually inspect arrows, boundaries, labels and clipping. The included SVGs were rendered with Mermaid CLI/Mermaid 12.2.0, local Chrome and [this configuration](diagrams/mermaid-config.json). Rendering tools are not application dependencies. From the package root, with a compatible rendering browser configured:

```sh
npm install --prefix /tmp/adcp-diagrams --ignore-scripts --no-audit --no-fund @mermaid-js/mermaid-cli@12.2.0 mermaid@12.2.0
/tmp/adcp-diagrams/node_modules/.bin/mmdc -p /path/to/puppeteer.json -c docs/architecture/diagrams/mermaid-config.json -i docs/architecture/diagrams/system-overview.mmd -o docs/architecture/diagrams/system-overview.svg -b white
```

The optional Puppeteer JSON contains a local `executablePath` only. Omit `-p` if your Puppeteer installation manages its browser. Repeat for all six basenames. Do not put keys or run content into renderer configuration.
