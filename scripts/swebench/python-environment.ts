/** Verify nested test scripts resolve checkout packages before editable image installs.
 * find_spec only inspects top-level package locations; it does not import their code.
 */
export const pythonSourceProbe = (root = "/workspace") => `
import importlib.machinery, pathlib, sys
root = pathlib.Path(${JSON.stringify(root)}).resolve()
roots = [root, root / 'src']
# A nested test script replaces sys.path[0]; do not let -c's cwd mask bad image setup.
search = sys.path[1:]
assert root in [pathlib.Path(p).resolve() for p in search], 'CHECKOUT_PYTHONPATH_MISSING'
checked = 0
for source in roots:
    if not source.is_dir():
        continue
    for package in source.iterdir():
        if not package.is_dir() or not (package / '__init__.py').is_file():
            continue
        spec = importlib.machinery.PathFinder.find_spec(package.name, search)
        assert spec is not None and spec.origin is not None, 'CHECKOUT_PACKAGE_UNRESOLVED'
        assert root in pathlib.Path(spec.origin).resolve().parents, 'CHECKOUT_PACKAGE_SHADOWED'
        checked += 1
print('CHECKOUT_IMPORT_BINDING_OK', checked)
`;
