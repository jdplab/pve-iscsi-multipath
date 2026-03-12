# Project: pve-iscsi-multipath

Proxmox VE plugin adding iSCSI, Fibre Channel, and multipath SAN management to the node UI.

## Code Graph

CodeGraphContext is configured and indexed for this project. Use it before reading files:

- `find_code` — look up functions, classes, or content by name/keyword
- `analyze_code_relationships` — understand dependencies between functions
- `find_dead_code` — identify unused functions

Re-index if the source files change significantly: `cgc index .`

## Source Layout

- `src/perl/PVE/API2/ISCSIMultipath.pm` — all API endpoints and backend logic
- `src/js/pve-iscsi-multipath.js` — ExtJS UI panels (iSCSI, Multipath, FC tabs)
- `t/` — Perl test suite (55 tests), run with `make test`
- `debian/` — packaging scripts (postinst patches Nodes.pm and index.html.tpl)

## Build & Deploy

```bash
make deb                                          # builds pve-iscsi-multipath_0.2.0_all.deb
scp *.deb root@<node>:/tmp/
ssh root@<node> dpkg -i /tmp/pve-iscsi-multipath_0.2.0_all.deb
```

Three cluster nodes: cclabhost21/22/23 at 192.168.121.21/22/23

## Branch Workflow

- Work on `dev`, PR to `main`
- Tag `main` to trigger a release: `git tag vX.Y.Z && git push origin vX.Y.Z`
- CI runs `make test` on all PRs; release workflow builds the `.deb` on tags
