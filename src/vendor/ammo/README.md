# Ammo.js

Unmodified upstream WASM build, pinned to the commit used by the Three.js cloth
and soft-volume examples:

https://github.com/kripken/ammo.js/tree/79190a1f03845794b1bba1777f30037349967658

The runtime loads these files locally, without a CDN. License: zlib; see LICENSE.

SHA-256:

- `ammo.wasm.js`: `040d0fbbda2d27b712d5acd68653fad334b5b2e00257c95fbee479fd121342a3`
- `ammo.wasm.wasm`: `2233804e614f9f646da21c680cf30e057a00c3e69dd57f965fa92d08ac3184f6`

This is a generic Bullet soft-body solver, not a port of MagicaCloth. The model
format does not depend on this library or its solver settings.
