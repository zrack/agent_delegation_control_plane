# Third-party notices

The optional coding pilot builds from the official Python Docker image, pinned by digest in its Dockerfile. Python and Debian components retain their upstream licenses and notices. The image is an execution dependency and is not bundled into this source distribution.

The viewer and scripted experiment use browser-native APIs and Python/Node standard libraries. No third-party runtime source, fonts, dependencies or binary executables are vendored in this package. Dependencies installed by users retain their own licenses; this project's Apache-2.0 license does not replace those terms.

The optional SDK runner uses the separately installed, pinned packages below. The table records license labels from installed distribution metadata for these exact versions; it is not a legal opinion or an exhaustive redistribution review. Consult each installed distribution's LICENSE/NOTICE files before redistributing dependency code or binaries.

| Package | Version | Reported license |
| --- | --- | --- |
| annotated-types | 0.8.0 | MIT |
| anyio | 4.16.0 | MIT |
| attrs | 26.1.0 | MIT |
| certifi | 2026.10.23 | Mozilla Public License 2.0 (MPL 2.0) |
| cffi | 2.1.1 | MIT-0 |
| charset-normalizer | 3.5.2 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| cryptography | 50.0.2 | Apache-2.0 OR BSD-3-Clause |
| griffelib | 2.4.1 | ISC |
| h11 | 0.16.0 | MIT License |
| httpcore2 | 2.16.0 | BSD-3-Clause |
| httpx2 | 2.16.0 | BSD-3-Clause |
| idna | 3.20 | BSD-3-Clause |
| jiter | 0.18.0 | MIT |
| jsonschema | 4.26.0 | MIT |
| jsonschema-specifications | 2025.9.1 | MIT |
| mcp | 2.3.0 | MIT License |
| mcp-types | 2.3.0 | MIT License |
| openai | 3.42.1 | Apache-2.0 |
| openai-agents | 0.24.0 | MIT |
| opentelemetry-api | 1.45.2 | Apache-2.0 |
| pycparser | 3.12 | BSD-3-Clause |
| pydantic | 2.14.2 | MIT |
| pydantic_core | 2.50.2 | MIT |
| PyJWT | 2.15.1 | MIT |
| python-multipart | 0.0.33 | Apache-2.0 |
| referencing | 0.37.0 | MIT |
| requests | 2.34.2 | Apache Software License |
| rpds-py | 2026.9.1 | MIT |
| sniffio | 1.3.1 | MIT License; Apache Software License |
| sse-starlette | 3.6.0 | BSD-3-Clause |
| starlette | 1.10.0 | BSD-3-Clause |
| truststore | 0.10.5 | MIT |
| typing-inspection | 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| urllib3 | 2.8.0 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |
| websockets | 16.1.1 | BSD-3-Clause |

Architecture diagrams are original project-authored Mermaid sources, rendered with Mermaid/CLI 12.2.0 (MIT-licensed rendering tools). Those tools are not bundled. The generated diagrams and other original project materials are covered by the project's [license](LICENSE) and [notice](NOTICE). GitHub Actions used by the optional workflow are fetched separately and retain their own terms.
