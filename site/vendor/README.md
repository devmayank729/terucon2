# site/vendor: third-party scripts the pages need, kept in the repository

The Claude Design page runtime loads React from unpkg.com on every page, and the home page's 3D façade loads three.js from
unpkg.com when it opens. Both are served from this site instead (no third-party host is contacted by any page), by
`tools/build-dist.js`, which copies these files into `dist/assets/` under content-hashed names with the other page assets.

Fetched on 2026-11-02 with `npm pack <name>@<version>` into an empty folder; the tarball's sha512 matched the registry's
`dist.integrity` in every case. Nothing here is edited.

| File | From | Bytes | sha384 |
|---|---|---|---|
| `react.production.min.js` | `react@18.3.1`, `umd/react.production.min.js` | 10751 | `sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z` |
| `react-dom.production.min.js` | `react-dom@18.3.1`, `umd/react-dom.production.min.js` | 131835 | `sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1` |
| `three.module.min.js` | `three@0.184.0`, `build/three.module.min.js` | 364998 | `sha384-35WaVqXNGvw49+RCXk67Ci9ebo55/5+CfirDbAVSG21KV8/7gO4xwIkhA5ZRcUHc` |
| `three.core.min.js` | `three@0.184.0`, `build/three.core.min.js` | 384222 | `sha384-/2vXInuUL2LKgd3n86c5RIzG+YC7vk3zYPTknaEkF2H2sauHtaOrS8swZ+MURxU6` |
| `LICENSE-react.txt`, `LICENSE-three.txt` | the packages' MIT licences | | |

- The two React hashes are exactly the SRI constants (`REACT_SRI`, `REACT_DOM_SRI`) inside the page runtime, and the files are
  byte-identical to the copies the original bundles embed. `tools/build-dist.js` re-checks both hashes on every build and stops
  if a file was changed or the runtime starts to expect another version.
- three.js: the page's façade script imports `https://unpkg.com/three@0.184.0/build/three.module.js`. The build rewrites that
  address to this site's copy. The minified build is used (365 KB + 384 KB instead of 649 KB + 1.4 MB); `three.module.min.js`
  exports the same 441 names as `three.module.js` (checked), and imports `./three.core.min.js`, whose address the build also
  rewrites to the hashed copy.

To update a version: `npm pack react@X react-dom@X three@Y` in an empty scratch folder, copy the same files over these, and
update the table, the constants at the top of `tools/build-dist.js`, and the address the façade script imports.
