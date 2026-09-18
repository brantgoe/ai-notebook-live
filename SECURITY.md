# Security

## Reporting a problem

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/brantgoe/ai-notebook-live/security) and click
**Report a vulnerability**. The report is visible only to the maintainer, and
you keep a thread to follow up in.

Please include what you did, what happened, and which version
(`AI Notebook: Show Log` prints it on the first line).

**Please do not open a public issue for a security bug**, and do not post a
working exploit anywhere public before it is fixed.

This is a small project maintained by one person. There is no bounty and no
guaranteed response time, but reports are read.

## What this extension can do, so you know what to look for

- It runs a **loopback-only** HTTP bridge, **off by default**. While it is on,
  any program on the same machine that can read `~/.ai-notebook-live/bridge.json`
  can read the open notebook (including cell outputs), add cells, and overwrite
  existing ones.
- It can **execute** notebook cells, but only within the policy in
  `aiNotebookLive.execution` / `aiNotebookLive.bridge.execution`. The default for
  agent-supplied code is `never`. A caller may lower that decision, never raise it.
- It sends notebook contents to Anthropic — through the `claude` CLI you already
  have logged in, or the API if you supply a key. See "Privacy" in the README.

## Verifying a release

Releases are `.vsix` files attached to GitHub Releases. The `.vsix` itself is a
zip and is not byte-reproducible (it embeds file mtimes), but the code inside it
is:

```bash
unzip -p ai-notebook-live-<version>.vsix extension/dist/extension.js | sha256sum
git checkout v<version> && npm ci && npm run build && sha256sum dist/extension.js
```

Those two hashes should match. If they do not, do not install it — say so at the
address above.

## Known limits

- The bridge trusts any local process holding the token. It is not a boundary
  against something already running as you; it is a boundary against the network
  and against a web page. See "Security" in the README for what is enforced.
- Windows is not supported for the `claude` CLI provider.
