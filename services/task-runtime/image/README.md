# Task runtime image

This recipe packages the deterministic `socrates.task-runtime.v1` bundle. The
base is the digest-pinned, multi-platform Docker Official Image for Node.js
22.23.1 on Debian Bookworm slim.

Build the bundle first and pass both values from `dist/build-identity.json` as
build arguments. A deployment must assign its own repository plus
platform-specific digest after building; a mutable local tag is never catalog
authority.

The resulting OCI configuration has one fixed entrypoint, an empty command,
user `65534:65534`, and no declared volumes or healthcheck. The local runner
still overrides and verifies user, namespaces, root filesystem, mounts,
capabilities, seccomp, AppArmor, resources, network, and cleanup.
