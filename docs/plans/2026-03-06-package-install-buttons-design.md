# Package Install Buttons Design

**Date:** 2026-03-06

## Goal

Allow operators to install missing prerequisite packages directly from the node panel UI, without running the full SAN Setup Wizard.

## Approach

Approach A: conditional toolbar buttons. Each node panel checks package status on load and shows install buttons only when the relevant package is missing. Buttons disappear once installed.

## Backend

**New endpoint:** `POST /nodes/{node}/iscsi/install`

- Parameter: `package` (enum: `open-iscsi`, `multipath-tools`, `sanlock`)
- Permission: `Sys.Modify`
- Runs as `fork_worker` task, returns UPID
- Uses eval+check pattern: tolerates apt-get non-zero exit if package ends up installed (handles broken `freenas-proxmox` postinst)

## Frontend

### iSCSI tab (`PVE.node.ISCSIPanel`)

On panel load, call the status endpoint. If `d.packages.open_iscsi` is false, show an **"Install open-iscsi"** button in the toolbar. Hidden when already installed.

### Multipath tab (`PVE.node.MultipathPanel`)

On panel load, call the status endpoint. If `d.packages.multipath_tools` is false, show an **"Install multipath-tools"** button in the toolbar. Hidden when already installed.

### "Add LVM Storage" inline sanlock prompt

When the user clicks "Add LVM Storage" on the iSCSI sessions grid, before opening the LVM dialog:

1. Call the status endpoint to check `d.packages.sanlock`
2. If sanlock is missing, show a confirmation dialog:
   > "sanlock is not installed. It is required for clustered LVM locking across nodes. Would you like to install it now?"
   > [Install & Continue] [Skip] [Cancel]
3. "Install & Continue" — POST to install endpoint with package=sanlock, poll task, then open LVM dialog on success
4. "Skip" — proceed to LVM dialog without installing
5. "Cancel" — abort

sanlock is NOT bundled into the other install buttons — it is only needed for clustered LVM, not for basic iSCSI or multipath operation.

### Task polling helper

A shared pollTask(nodename, upid, onDone) function polls /nodes/{node}/tasks/{upid}/status every 2 seconds until status === 'stopped', then calls onDone(exitstatus). Used by all install flows.

## What this does NOT change

- The SAN Setup Wizard continues to handle all package installs in bulk during full setup
- lvm2 has no install button — it is a Proxmox base package and is always present
- FC tab has no install button — FC uses kernel modules, no apt package required
