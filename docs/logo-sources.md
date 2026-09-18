# Logo sources and usage notes

Court shows provider marks only to identify integrations. The marks do not imply endorsement or partnership. Keep them visually separate from the Court name, preserve their proportions, and give each icon an accessible text label.

## Recommended source set

The most practical consistent set is the SVG collection already maintained by CLIProxyAPI, Court's routing dependency. Its repository is MIT licensed, and the asset paths match the provider names Court uses. Vendor local copies instead of loading them from a CDN.

| Court provider | SVG source | Brand reference | Notes |
| --- | --- | --- | --- |
| OpenAI / Codex | [CLIProxyAPI `openai.svg`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/assets/logo/openai.svg) | [OpenAI design guidelines](https://openai.com/brand/) | OpenAI says to use its logo only when it directly relates to OpenAI services, use it exactly as provided, and avoid suggesting endorsement. Do not recolor, crop, distort, or combine the Blossom with Court's identity. |
| Anthropic / Claude | [CLIProxyAPI `claude.svg`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/assets/logo/claude.svg) | [Anthropic company site](https://www.anthropic.com/company) | Anthropic does not expose a public downloadable brand kit in the pages found during this check. Use the upstream routing project's existing SVG only as a small provider identifier. Do not present it as a Court logo or partnership badge. |
| Google Antigravity | [CLIProxyAPI `antigravity.svg`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/assets/logo/antigravity.svg) | [Google Antigravity](https://antigravity.google/) | Prefer the product-specific Antigravity mark over a generic Google or Gemini mark. Keep the SVG unchanged and label it "Google Antigravity" in text. |
| Google Gemini | [Simple Icons `googlegemini.svg`](https://github.com/simple-icons/simple-icons/blob/develop/icons/googlegemini.svg) | [Gemini CLI](https://geminicli.com/) | Used only to identify the official Gemini CLI integration. The vendored file is from Simple Icons' CC0 collection; Google's trademark rights remain separate. |
| xAI / Grok | [CLIProxyAPI `xai.svg`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/assets/logo/xai.svg) | [xAI brand guidelines](https://x.ai/legal/brand-guidelines) | xAI allows marks only for accurate references to its services. It forbids implying approval or sponsorship and says downloaded logos must remain unaltered. Do not recolor this SVG. |
| Moonshot AI / Kimi | [CLIProxyAPI `kimi.svg`](https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/assets/logo/kimi.svg) | [Moonshot AI](https://www.moonshot.ai/) and [Kimi](https://www.kimi.com/) | Neither first-party page exposed a downloadable brand kit in this check. Use the upstream SVG as a provider identifier, at modest size, with the text label "Kimi". |
| OpenCode | [Official OpenCode brand page](https://opencode.ai/brand) | [OpenCode repository license](https://github.com/anomalyco/opencode/blob/dev/LICENSE) | The brand page embeds official light and dark SVG wordmarks and offers an asset download. Use the icon or wordmark from that page without modifying its geometry or colors. The code repository is MIT licensed, but trademark rights are separate from the software license. |

CLIProxyAPI's [MIT license](https://github.com/router-for-me/CLIProxyAPI/blob/main/LICENSE) requires the copyright and permission notice to remain with copied or substantial portions of its software. If Court vendors these files, add the upstream notice to `THIRD_PARTY_NOTICES.md` and retain this source record.

## Important license distinction

An open-source license for an SVG file does not grant ownership of the provider's trademark. Use each mark only to identify its matching integration. Avoid these uses:

- putting a provider mark beside the "Court Router" name as if it were Court's own logo;
- changing brand geometry, colors, or proportions;
- implying the provider sponsors, certifies, or endorses Court;
- using a provider mark more prominently than Court's name;
- naming Court or a Court feature after a provider trademark.

## Simple Icons fallback

[Simple Icons](https://github.com/simple-icons/simple-icons) can fill a missing mark, but it should be a fallback, not the first source. The collection is published under [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/develop/LICENSE.md). Its own [disclaimer](https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md) says that CC0 for the collection does not mean every included brand icon is free of separate license or trademark restrictions. Check the individual icon metadata and the provider's current brand rules before adding one.

## Maintenance

Brand files and rules change. Record the exact upstream URL and commit SHA when vendoring each SVG. Recheck the provider's brand page before a public release, and keep all assets local so the dashboard does not leak visits to third-party CDNs.
