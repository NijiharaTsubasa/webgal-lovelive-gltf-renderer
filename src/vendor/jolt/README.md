# Jolt Physics WebAssembly

Unmodified single-thread WASM distribution from the official `jolt-physics`
npm package, version `1.1.0`, MIT licensed.

- Upstream: https://github.com/jrouwe/JoltPhysics.js
- Archive: https://registry.npmjs.org/jolt-physics/-/jolt-physics-1.1.0.tgz
- `jolt-physics.wasm.js` SHA-256: `bcebc61c2a5db94f1b155b2ce1902667f952d9d63baa003b654e9e5d1ff20eb4`
- `jolt-physics.wasm.wasm` SHA-256: `65f044b2ec57be2bbf0f84828f3948d6f3f9e17942ad80aa98923b94dd292f90`

`jolt-cloth-solver.js` supplies the local WASM bytes to the factory. One shared
module owns one reference-counted world; native collision groups isolate cloth
instances, including characters at overlapping positions. Public `CustomUpdate`
steps only the requested cloth, so per-character warmup/reset never advances
other characters. Constraints and collision response remain inside Jolt.

The fixed release maps to upstream commit
`c9c122bcd48e92885fbee7d267c928c3781d581c`. Its `JoltInterface` constructor and
destructor own the module-global Factory/type registry: creating independent
interfaces on the same module would be unsafe when disposing one character.
