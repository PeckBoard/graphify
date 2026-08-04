// The graphify driver: one Python program the plugin ships as a string and
// runs through `peckboard_exec`, plus the helpers that build its argv, read its
// output, and get graphify installed in the first place.
//
// graphify (PyPI `graphifyy`, import name `graphify`) has NO build CLI — its
// `__main__` only offers install / benchmark / hook — so the deterministic
// headless build has to be driven from the library. `graphify.watch._rebuild_code`
// is that path; the driver reimplements it rather than calling it, because
// `_rebuild_code` always targets the whole watch root, returns only a bool, and
// drops every file whose *absolute* path contains a dotted part (which silently
// empties any repo living under `.peckboard/worktrees/...`).

import { exec, getSetting, type ExecResult } from "./host";
import { PATH_IMAGE_PY } from "./pathimage";

/// Interpreter used when the `python_bin` setting is unset. Must stay on core's
/// EXEC_ALLOWLIST (peckboard/src/plugin/host.rs).
export const DEFAULT_PYTHON = "python3";

/// PyPI distribution name. The import name is `graphify`, not this.
export const PYPI_PACKAGE = "graphifyy";

/// What a user runs by hand when the automatic install outruns the command
/// ceiling. Surfaced verbatim so it can be copy-pasted. Mirrors what the
/// driver's `install` subcommand does: a private venv at the folder root, so it
/// works on hosts whose system Python has no pip or is externally managed.
export const MANUAL_INSTALL_COMMAND =
  "python3 -m venv .graphify-venv && .graphify-venv/bin/python -m pip install graphifyy";

/// A cold install pulls graspologic (scipy/numba) plus ~14 tree-sitter wheels.
/// 600 is core's EXEC_MAX_TIMEOUT_SECS — asking for more is silently clamped.
export const INSTALL_TIMEOUT_SECS = 600;

/// Queries (path / explain / summary / graph) only import networkx and read one
/// JSON file, but a cold interpreter start on a large graph still isn't instant.
export const QUERY_TIMEOUT_SECS = 120;

/// Nodes the `graph` subcommand returns before it starts dropping the
/// least-connected ones. `peckboard_exec` caps a stream at 1 MiB and the compact
/// node-link encoding runs ~120 bytes a node, so this leaves headroom.
export const DEFAULT_MAX_NODES = 1500;

// ── The driver ───────────────────────────────────────────────────────────────

/// The Python program, run as `python3 -c DRIVER <subcommand> [args...]`.
/// This is real shipping code, not a snippet: it is the whole graphify
/// integration. Two contracts it must never break are commented inline — the
/// single-line-JSON stdout protocol, and the repo path jail.
export const PYTHON_DRIVER = `"""graphify driver for the Peckboard graphify plugin.

Invoked as: python3 -c "<this source>" <subcommand> [args...]

STDOUT CONTRACT
  The last line of stdout that parses as a JSON object IS the result, and the
  driver writes exactly one. graphify pulls in graspologic, numba and a dozen
  tree-sitter wheels, several of which print on import, so the caller cannot
  parse the whole stream. Every exit path -- including every failure -- goes
  through _emit, so a traceback is never the only thing on stdout.
"""
import json
import shutil
import sys
from pathlib import Path

${PATH_IMAGE_PY}

# The extensions graphify's own code pass walks (graphify/watch.py
# _CODE_EXTENSIONS). Duplicated rather than imported because the walk below has
# to run before graphify is known to be importable.
CODE_EXTENSIONS = (
    ".py", ".ts", ".js", ".go", ".rs", ".java", ".cpp", ".c", ".rb", ".swift",
    ".kt", ".cs", ".scala", ".php", ".cc", ".cxx", ".hpp", ".h", ".kts",
)

# Directories no walk descends into: the same build/vendor names core skips
# (peckboard/src/service/fs_jail.rs is_ignored_dir), plus graphify's own output.
IGNORED_DIRS = {
    "node_modules", "target", "dist", "build", "vendor", "out", "bin", "obj",
    "coverage", "__pycache__", "venv", "graphify-out",
}

# How deep the repo scan descends (peckboard/src/service/repo_scan.rs
# MAX_SCAN_DEPTH), and a cap so a pathological tree cannot blow up one call.
MAX_SCAN_DEPTH = 8
MAX_REPOS = 200

GOD_NODE_COUNT = 20

# PyPI distribution name (the import name is \`graphify\`), and the private venv
# the plugin installs it into, at the folder root. The leading dot keeps it out
# of graphify's own file walk and out of this driver's repo scan.
PYPI_PACKAGE = "graphifyy"
VENV_DIRNAME = ".graphify-venv"


def _emit(obj):
    # The leading newline closes any partial line a library left behind, so the
    # result always starts a line of its own.
    print()
    print(json.dumps(obj))
    sys.stdout.flush()


def _repo_root(rel):
    """Resolve the caller-supplied repo argument under the folder root.

    Core pins this process's cwd to the folder root, but \`rel\` is chosen by
    whoever called the tool, so it is re-validated here rather than trusted: it
    must be relative, and it must resolve to the folder root itself or to a
    descendant of it. An absolute path and any '..' that climbs out are refused.
    The plugin runs the same check before it ever gets here; this is the copy
    that matters, because it is the one next to the filesystem.
    """
    root = Path.cwd().resolve()
    candidate = Path(rel)
    if candidate.is_absolute():
        raise ValueError("repo must be a path relative to the folder root: " + rel)
    target = (root / candidate).resolve()
    if target != root and root not in target.parents:
        raise ValueError("repo path escapes the folder root: " + rel)
    return target


def _out_dir(root):
    return root / "graphify-out"


def _graph_path(root):
    return _out_dir(root) / "graph.json"


def _code_files(root):
    """Every source file under \`root\` graphify can parse.

    graphify's own filter rejects a file if ANY part of its absolute path
    starts with a dot, which empties a repo checked out under a dotted
    directory (Peckboard card worktrees live at .peckboard/worktrees/<id8>).
    Only the path relative to the repo root is inspected here.
    """
    files = []
    for path in root.rglob("*"):
        if path.suffix not in CODE_EXTENSIONS or not path.is_file():
            continue
        parts = path.relative_to(root).parts[:-1]
        if any(p.startswith(".") or p in IGNORED_DIRS for p in parts):
            continue
        files.append(path)
    return sorted(files)


def _graphify_version():
    try:
        from importlib.metadata import version
    except ImportError:
        return None
    for name in ("graphifyy", "graphify"):
        try:
            return version(name)
        except Exception:
            continue
    return None


def _label(G, nid):
    return G.nodes[nid].get("label", nid)


def _load_graph(root, rel):
    path = _graph_path(root)
    if not path.exists():
        raise ValueError("no graph for " + rel + " \\u2014 run graphify_build first")
    from networkx.readwrite import json_graph
    try:
        data = json.loads(path.read_text())
    except ValueError as exc:
        raise ValueError("graph.json is corrupted (" + str(exc) + ") \\u2014 rebuild")
    return json_graph.node_link_graph(data, edges="links")


def _god_nodes(G):
    """graphify's own ranking when it is importable: it drops file-level hub
    nodes and AST method stubs, which raw degree order would put on top.

    The degree key is read defensively -- graphify 0.9.x returns \`degree\`, and
    falling back to the graph itself means a future rename shows real numbers
    rather than a column of zeros."""
    try:
        from graphify.analyze import god_nodes
        ranked = god_nodes(G, top_n=GOD_NODE_COUNT)
        out = []
        for n in ranked:
            nid = n.get("id")
            degree = n.get("degree")
            if degree is None:
                degree = n.get("edges")
            if degree is None:
                degree = G.degree(nid) if nid is not None and nid in G else 0
            out.append({"label": n.get("label", nid or ""), "degree": degree})
        return out
    except Exception:
        pairs = sorted(G.degree(), key=lambda item: item[1], reverse=True)[:GOD_NODE_COUNT]
        return [{"label": _label(G, n), "degree": d} for n, d in pairs]


def _payload(root, rel, max_nodes):
    """The one result shape every graph-reading subcommand returns.

    \`totals\` and \`communities\` always describe the WHOLE graph; \`nodes\` and
    \`links\` are the capped detail the visualizer draws (empty when max_nodes is
    0). Aggregates are computed here rather than in the plugin because the full
    graph does not fit through the 1 MiB stdout cap.
    """
    G = _load_graph(root, rel)
    degree = dict(G.degree())

    members = {}
    for nid, data in G.nodes(data=True):
        cid = data.get("community")
        if cid is not None:
            members.setdefault(int(cid), []).append(nid)

    confidence = {"EXTRACTED": 0, "INFERRED": 0, "AMBIGUOUS": 0}
    for _u, _v, edata in G.edges(data=True):
        key = str(edata.get("confidence") or "EXTRACTED").upper()
        confidence[key] = confidence.get(key, 0) + 1

    payload = {
        "ok": True,
        "repo": rel,
        "totals": {
            "nodes": G.number_of_nodes(),
            "edges": G.number_of_edges(),
            "communities": len(members),
            "confidence": confidence,
        },
        "top_nodes": _god_nodes(G),
        "communities": [
            {"id": cid, "size": len(ids), "label": "Community " + str(cid)}
            for cid, ids in sorted(members.items(), key=lambda kv: len(kv[1]), reverse=True)
        ],
        "nodes": [],
        "links": [],
        "truncated": False,
        "built_at": int(_graph_path(root).stat().st_mtime * 1000),
    }
    if max_nodes <= 0:
        return payload

    keep_ids = sorted(degree, key=lambda n: degree[n], reverse=True)[:max_nodes]
    payload["truncated"] = len(keep_ids) < G.number_of_nodes()
    keep = set(keep_ids)
    for nid in keep_ids:
        data = G.nodes[nid]
        payload["nodes"].append({
            "id": nid,
            "label": data.get("label", nid),
            "community": data.get("community"),
            "source_file": data.get("source_file", ""),
            "source_location": str(data.get("source_location", "")),
            "degree": degree[nid],
        })
    for u, v, edata in G.edges(data=True):
        if u in keep and v in keep:
            payload["links"].append({
                "source": u,
                "target": v,
                "relation": edata.get("relation", ""),
                "confidence": str(edata.get("confidence") or ""),
            })
    return payload


def _score_nodes(G, terms):
    """graphify/serve.py _score_nodes: a term in the label is worth 1, the same
    term in the node's source file 0.5."""
    scored = []
    for nid, data in G.nodes(data=True):
        label = str(data.get("label", "")).lower()
        source = str(data.get("source_file", "")).lower()
        score = sum(1 for t in terms if t in label) + sum(0.5 for t in terms if t in source)
        if score > 0:
            scored.append((score, nid))
    return sorted(scored, reverse=True)


def _find_node(G, label):
    """graphify/serve.py _find_node: loose match on the label, exact on the id."""
    term = str(label).lower()
    return [nid for nid, d in G.nodes(data=True)
            if term in str(d.get("label", "")).lower() or term == str(nid).lower()]


def _terms(text):
    return [t.lower() for t in str(text).split() if t]


def _venv_dir():
    return Path.cwd().resolve() / VENV_DIRNAME


def _venv_site_packages(venv):
    """The venv's site-packages, or None. Globbed rather than constructed,
    because the directory name carries the interpreter's minor version."""
    for pattern in ("lib/python*/site-packages", "Lib/site-packages"):
        for candidate in sorted(venv.glob(pattern)):
            if candidate.is_dir():
                return candidate
    return None


def _activate_venv():
    """Put the plugin's private venv on sys.path, when it exists.

    The plugin may only ask core to run an executable from its EXEC_ALLOWLIST,
    and a venv interpreter is an absolute path -- which core refuses outright.
    So the venv is never *executed*: the allowlisted system python3 runs this
    driver and imports out of the venv's site-packages. That also keeps
    graphify's heavy dependency tree (graspologic, numba, scipy, ~14
    tree-sitter wheels) out of the system and user site directories.
    """
    site = _venv_site_packages(_venv_dir())
    if site is not None and str(site) not in sys.path:
        sys.path.insert(0, str(site))


def cmd_probe(argv):
    try:
        import graphify  # noqa: F401
    except Exception as exc:
        return {
            "ok": True,
            "installed": False,
            "version": None,
            "venv": str(_venv_dir()),
            "detail": str(exc),
        }
    return {
        "ok": True,
        "installed": True,
        "version": _graphify_version(),
        "venv": str(_venv_dir()),
    }


def cmd_install(argv):
    """Create the private venv and install graphify into it.

    Deliberately NOT 'python3 -m pip install --user': many hosts ship a Python
    with no pip module at all (this one does), and those that do are often
    marked externally-managed, where a --user install is refused outright. A
    venv sidesteps both -- venv is in the stdlib, and \`with_pip\` bootstraps pip
    from ensurepip without touching anything outside the venv directory.

    Running the venv's own interpreter here is not a sandbox escape: core has
    already granted this plugin \`process_exec\` for \`python3\`, whose whole job
    is to run this arbitrary driver source. The jail that matters -- the cwd
    pinned to the folder root -- is unchanged.
    """
    import subprocess
    import venv as venv_mod

    venv_dir = _venv_dir()
    created = False
    if _venv_site_packages(venv_dir) is None:
        venv_mod.create(str(venv_dir), with_pip=True, clear=True)
        created = True

    python = venv_dir / "bin" / "python"
    if not python.exists():
        python = venv_dir / "Scripts" / "python.exe"
    if not python.exists():
        raise RuntimeError("venv created but no interpreter found at " + str(venv_dir))

    proc = subprocess.run(
        [str(python), "-m", "pip", "install", "--disable-pip-version-check", PYPI_PACKAGE],
        capture_output=True,
        text=True,
    )

    _activate_venv()
    probe = cmd_probe([])
    return {
        "ok": True,
        "created_venv": created,
        "venv": str(venv_dir),
        "installed": probe.get("installed", False),
        "version": probe.get("version"),
        "exit_code": proc.returncode,
        "output": ((proc.stdout or "") + (proc.stderr or ""))[-4000:],
    }


def _scan_repos(current, depth, out):
    """Mirror of peckboard/src/service/repo_scan.rs: a directory whose .git is
    itself a directory is a repo, and a repo's insides are not descended into
    (a vendored checkout stays invisible)."""
    if depth > MAX_SCAN_DEPTH or len(out) >= MAX_REPOS:
        return
    if (current / ".git").is_dir():
        out.append(current)
        return
    try:
        entries = sorted(current.iterdir())
    except OSError:
        return
    for entry in entries:
        if entry.is_symlink() or not entry.is_dir():
            continue
        if entry.name.startswith(".") or entry.name in IGNORED_DIRS:
            continue
        _scan_repos(entry, depth + 1, out)


def cmd_repos(argv):
    """Every graph target in the folder, each with its existing graph's totals.

    Summaries are gathered in this one process on purpose: a separate
    interpreter start per repo would pay the networkx import over and over.
    The install state rides along for the same reason -- the page asks for the
    repo list and "is graphify there?" at the same moment.
    """
    root = Path.cwd().resolve()
    found = []
    _scan_repos(root, 0, found)
    repos = []
    for path in found:
        rel = "." if path == root else path.relative_to(root).as_posix()
        repos.append({"path": rel, "name": path.name})
    # A folder that is not (and holds no) git repo is still a fine graph target.
    if not repos:
        repos = [{"path": ".", "name": root.name}]
    for entry in repos:
        target = root if entry["path"] == "." else root / entry["path"]
        if not _graph_path(target).exists():
            entry["has_graph"] = False
            continue
        try:
            summary = _payload(target, entry["path"], 0)
            entry["has_graph"] = True
            entry["totals"] = summary["totals"]
            entry["top_nodes"] = summary["top_nodes"]
            entry["built_at"] = summary["built_at"]
        except Exception as exc:
            entry["has_graph"] = False
            entry["error"] = str(exc)
    probed = cmd_probe([])
    return {"ok": True, "repos": repos,
            "installed": probed["installed"], "version": probed["version"]}


def cmd_build(argv):
    rel = argv[0] if argv else "."
    full = "--full" in argv[1:]
    root = _repo_root(rel)
    if not root.is_dir():
        raise ValueError("no such directory: " + rel)

    from graphify.extract import extract
    from graphify.build import build_from_json
    from graphify.cluster import cluster, score_all
    from graphify.analyze import god_nodes, surprising_connections, suggest_questions
    from graphify.report import generate
    from graphify.export import to_json

    out = _out_dir(root)
    if full:
        # graphify caches per-file extraction under graphify-out/cache, keyed by
        # the file's SHA256 (graphify/cache.py). Dropping that directory is what
        # a full rebuild means -- the library exposes no flag for it.
        shutil.rmtree(out / "cache", ignore_errors=True)

    files = _code_files(root)
    if not files:
        raise ValueError("no source files under '" + rel + "' that graphify can parse")

    result = extract(files)
    G = build_from_json(result)
    communities = cluster(G)
    cohesion = score_all(G, communities)
    gods = god_nodes(G)
    surprises = surprising_connections(G, communities)
    labels = {cid: "Community " + str(cid) for cid in communities}
    questions = suggest_questions(G, communities, labels)
    detection = {
        "files": {"code": [str(f) for f in files], "document": [], "paper": [], "image": []},
        "total_files": len(files),
        "total_words": sum(len(f.read_text(errors="ignore").split()) for f in files),
    }

    out.mkdir(parents=True, exist_ok=True)
    report = generate(G, communities, cohesion, labels, gods, surprises, detection,
                      {"input": 0, "output": 0}, str(root), suggested_questions=questions)
    (out / "GRAPH_REPORT.md").write_text(report)
    to_json(G, communities, str(_graph_path(root)))

    # A needs_update flag left by \`graphify watch\` is now satisfied.
    flag = out / "needs_update"
    if flag.exists():
        flag.unlink()

    payload = _payload(root, rel, 0)
    payload["files_parsed"] = len(files)
    payload["full_rebuild"] = full
    return payload


def cmd_summary(argv):
    rel = argv[0] if argv else "."
    return _payload(_repo_root(rel), rel, 0)


def cmd_graph(argv):
    rel = argv[0] if argv else "."
    max_nodes = 1500
    if "--max-nodes" in argv:
        idx = argv.index("--max-nodes")
        if idx + 1 < len(argv):
            max_nodes = int(argv[idx + 1])
    return _payload(_repo_root(rel), rel, max_nodes)


def cmd_path(argv):
    rel, source, target = argv[0], argv[1], argv[2]
    max_hops = int(argv[3]) if len(argv) > 3 and argv[3] else 8
    root = _repo_root(rel)
    G = _load_graph(root, rel)

    src_scored = _score_nodes(G, _terms(source))
    if not src_scored:
        return {"ok": True, "repo": rel, "found": False,
                "message": "no node matching source '" + str(source) + "'"}
    tgt_scored = _score_nodes(G, _terms(target))
    if not tgt_scored:
        return {"ok": True, "repo": rel, "found": False,
                "message": "no node matching target '" + str(target) + "'"}

    import networkx as nx
    src_nid, tgt_nid = src_scored[0][1], tgt_scored[0][1]
    try:
        nodes = nx.shortest_path(G, src_nid, tgt_nid)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return {"ok": True, "repo": rel, "found": False,
                "message": "no path between '" + str(_label(G, src_nid)) + "' and '"
                           + str(_label(G, tgt_nid)) + "'"}
    hops = len(nodes) - 1
    if hops > max_hops:
        return {"ok": True, "repo": rel, "found": False,
                "message": "path exceeds max_hops=" + str(max_hops) + " (" + str(hops) + " hops found)"}

    steps = []
    for i in range(len(nodes) - 1):
        u, v = nodes[i], nodes[i + 1]
        edata = G.edges[u, v]
        steps.append({
            "from": _label(G, u),
            "to": _label(G, v),
            "relation": edata.get("relation", ""),
            "confidence": str(edata.get("confidence") or ""),
            "source_file": G.nodes[v].get("source_file", ""),
        })
    result = {"ok": True, "repo": rel, "found": True, "hops": hops,
              "source": _label(G, src_nid), "target": _label(G, tgt_nid), "steps": steps}
    try:
        # The diagram is a courtesy: a renderer bug must never cost the caller
        # the answer it asked for.
        image = render_path_base64(result)
        if image:
            result["image_base64"] = image
    except Exception:
        pass
    return result


def cmd_explain(argv):
    rel, label = argv[0], argv[1]
    root = _repo_root(rel)
    G = _load_graph(root, rel)

    matches = _find_node(G, label)
    if not matches:
        # Fall back to the keyword scorer, so a multi-word query still lands.
        matches = [nid for _score, nid in _score_nodes(G, _terms(label))[:1]]
    if not matches:
        return {"ok": True, "repo": rel, "found": False,
                "message": "no node matching '" + str(label) + "'"}

    nid = matches[0]
    data = G.nodes[nid]
    degree = dict(G.degree())
    ranked = sorted(degree.items(), key=lambda item: item[1], reverse=True)
    rank = next((i + 1 for i, pair in enumerate(ranked) if pair[0] == nid), None)

    neighbors = []
    for nb in G.neighbors(nid):
        edata = G.edges[nid, nb]
        neighbors.append({
            "label": _label(G, nb),
            "relation": edata.get("relation", ""),
            "confidence": str(edata.get("confidence") or ""),
            "source_file": G.nodes[nb].get("source_file", ""),
        })

    cid = data.get("community")
    siblings = []
    if cid is not None:
        siblings = sorted(_label(G, other) for other, odata in G.nodes(data=True)
                          if other != nid and odata.get("community") == cid)

    return {
        "ok": True, "repo": rel, "found": True,
        "id": nid,
        "label": _label(G, nid),
        "source_file": data.get("source_file", ""),
        "source_location": str(data.get("source_location", "")),
        "community": cid,
        "community_size": len(siblings) + 1 if cid is not None else 0,
        "community_members": siblings[:40],
        "degree": degree.get(nid, 0),
        "degree_rank": rank,
        "total_nodes": G.number_of_nodes(),
        "neighbor_count": len(neighbors),
        "neighbors": neighbors[:60],
        "other_matches": [_label(G, m) for m in matches[1:6]],
    }


HANDLERS = {
    "probe": cmd_probe,
    "install": cmd_install,
    "repos": cmd_repos,
    "build": cmd_build,
    "summary": cmd_summary,
    "graph": cmd_graph,
    "path": cmd_path,
    "explain": cmd_explain,
}


def main():
    _activate_venv()
    argv = sys.argv[1:]
    sub = argv[0] if argv else ""
    handler = HANDLERS.get(sub)
    if handler is None:
        _emit({"error": "unknown driver subcommand: '" + sub + "'"})
        return
    try:
        _emit(handler(argv[1:]))
    except Exception as exc:
        # The caller reads the last JSON line and nothing else, so a traceback
        # on stderr must never be the whole story.
        _emit({"error": type(exc).__name__ + ": " + str(exc)})


main()
`;

// ── Path jail (TypeScript side) ──────────────────────────────────────────────

/// Normalize and validate the caller-supplied `repo` argument.
///
/// Core pins exec's cwd to the folder root, but `repo` comes from an agent (or
/// from a query string), so it is checked before it is ever handed to the
/// driver: relative segments only, no absolute path, no `..` that climbs above
/// the root. The driver repeats the check against the real filesystem — this
/// one exists so a bad argument fails with a clear message instead of a Python
/// exception, and so a future caller that skips the driver still can't escape.
export function resolveRepoPath(repo: unknown): string {
  const raw = typeof repo === "string" ? repo.trim() : "";
  const rel = raw === "" ? "." : raw;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`repo must be a path relative to the folder root, got '${rel}'`);
  }
  const parts: string[] = [];
  for (const segment of rel.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) {
        throw new Error(`repo path escapes the folder root: '${rel}'`);
      }
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length > 0 ? parts.join("/") : ".";
}

/// The `graphify-out/graph.json` path for a repo, relative to the folder root.
export function graphJsonPath(repo: string): string {
  const rel = resolveRepoPath(repo);
  return rel === "." ? "graphify-out/graph.json" : `${rel}/graphify-out/graph.json`;
}

// ── Invoking the driver ──────────────────────────────────────────────────────

export type DriverCommand =
  | { sub: "probe" }
  | { sub: "install" }
  | { sub: "repos" }
  | { sub: "build"; repo: string; full: boolean }
  | { sub: "summary"; repo: string }
  | { sub: "graph"; repo: string; maxNodes: number }
  | { sub: "path"; repo: string; source: string; target: string; maxHops: number }
  | { sub: "explain"; repo: string; label: string };

/// argv for one subcommand. There is no shell — `peckboard_exec` takes an argv
/// array — so nothing here is quoted or escaped. The repo argument passes
/// through the jail on the way in.
export function driverArgv(cmd: DriverCommand): string[] {
  const rest: string[] = [];
  switch (cmd.sub) {
    case "build":
      rest.push(resolveRepoPath(cmd.repo));
      if (cmd.full) rest.push("--full");
      break;
    case "summary":
      rest.push(resolveRepoPath(cmd.repo));
      break;
    case "graph":
      rest.push(resolveRepoPath(cmd.repo), "--max-nodes", String(cmd.maxNodes));
      break;
    case "path":
      rest.push(resolveRepoPath(cmd.repo), cmd.source, cmd.target, String(cmd.maxHops));
      break;
    case "explain":
      rest.push(resolveRepoPath(cmd.repo), cmd.label);
      break;
    default:
      break;
  }
  return ["-c", PYTHON_DRIVER, cmd.sub, ...rest];
}

/// The last stdout line that parses as a JSON object — the driver's result.
/// Scanning upward (rather than taking the literal last line) keeps a trailing
/// newline or a stray library log from breaking the read.
export function lastJsonLine(stdout: string): string | null {
  const lines = String(stdout ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      JSON.parse(line);
      return line;
    } catch (_e) {
      // Not ours — a library logged something dict-shaped. Keep looking.
    }
  }
  return null;
}

/// Turn one `peckboard_exec` result into the driver's parsed payload, or throw
/// with whatever the process actually said.
export function parseDriverOutput(res: ExecResult, sub: string): any {
  if (res.timed_out) {
    throw new Error(`graphify ${sub} timed out — raise the build timeout in the plugin settings, or run it on a smaller repo`);
  }
  const line = lastJsonLine(res.stdout);
  if (line === null) {
    const noise = (res.stderr || res.stdout || "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(
      `graphify ${sub} produced no result (exit ${res.exit_code})${noise ? `: ${noise}` : ""}`,
    );
  }
  const parsed = JSON.parse(line);
  if (parsed && typeof parsed.error === "string") {
    throw new Error(parsed.error);
  }
  return parsed;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/// Read a setting, falling back to the manifest default when core has no stored
/// value (an unconfigured plugin returns null).
function boolSetting(key: string, fallback: boolean): boolean {
  const v = getSetting(key);
  if (v === null || v === undefined) return fallback;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

function intSetting(key: string, fallback: number, min: number, max: number): number {
  const v = getSetting(key);
  const n = typeof v === "number" ? v : Number(v);
  if (!isFinite(n) || n === 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function pythonBin(): string {
  const v = getSetting("python_bin");
  return typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULT_PYTHON;
}

/// Should a found path come back with its diagram? Off means text only — the
/// image costs the model vision tokens on every call.
export function pathImageEnabled(): boolean {
  return boolSetting("path_image", true);
}

export function buildTimeoutSecs(): number {
  return intSetting("build_timeout_secs", 600, 30, 600);
}

// ── Public entry points ──────────────────────────────────────────────────────

/// Run one subcommand end to end.
export function runDriver(cmd: DriverCommand, timeoutSecs: number): any {
  return parseDriverOutput(exec(pythonBin(), driverArgv(cmd), timeoutSecs), cmd.sub);
}

export interface ProbeResult {
  installed: boolean;
  version: string | null;
  python_bin: string;
}

/// Is graphify importable by the configured interpreter?
export function probe(): ProbeResult {
  const bin = pythonBin();
  const parsed = parseDriverOutput(exec(bin, driverArgv({ sub: "probe" }), 60), "probe");
  return {
    installed: parsed?.installed === true,
    version: typeof parsed?.version === "string" ? parsed.version : null,
    python_bin: bin,
  };
}

export interface InstallResult {
  installed: boolean;
  timed_out: boolean;
  output: string;
  manual_command: string;
}

/// Create the plugin's private venv at the folder root and install graphify
/// into it. A cold install legitimately outruns core's 600s ceiling; when it
/// does, the manual command is the result — reporting success there would
/// leave the caller waiting on a graph that never comes.
export function installGraphify(): InstallResult {
  const bin = pythonBin();
  const res = exec(bin, driverArgv({ sub: "install" }), INSTALL_TIMEOUT_SECS);
  const output = tail(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ""}`, 4000);
  if (res.timed_out) {
    return { installed: false, timed_out: true, output, manual_command: MANUAL_INSTALL_COMMAND };
  }
  let parsed: any = null;
  try {
    parsed = parseDriverOutput(res, "install");
  } catch (_e) {
    // The driver failed before it could emit — fall back to a fresh probe
    // rather than reporting an install that may actually have landed.
  }
  return {
    installed: parsed?.installed === true || probe().installed,
    timed_out: false,
    output: parsed?.output ? tail(String(parsed.output), 4000) : output,
    manual_command: MANUAL_INSTALL_COMMAND,
  };
}

/// Guarantee graphify is importable before a tool runs, installing it first if
/// the `auto_install` setting allows. Throws with the manual command otherwise.
export function ensureGraphify(): ProbeResult {
  const first = probe();
  if (first.installed) return first;
  if (!boolSetting("auto_install", true)) {
    throw new Error(
      `graphify is not installed for ${first.python_bin}. Enable "Install graphify automatically" in the plugin settings, or run: ${MANUAL_INSTALL_COMMAND}`,
    );
  }
  const install = installGraphify();
  if (install.timed_out) {
    throw new Error(
      `installing graphify exceeded the ${INSTALL_TIMEOUT_SECS}s command ceiling — run it by hand: ${MANUAL_INSTALL_COMMAND}`,
    );
  }
  if (!install.installed) {
    throw new Error(
      `installing graphify failed — run it by hand: ${MANUAL_INSTALL_COMMAND}\n${install.output}`,
    );
  }
  return probe();
}

/// Keep the tail of a long command output; the head of a pip log is boilerplate
/// and the failure is always at the end.
export function tail(text: string, max: number): string {
  const s = String(text ?? "").trim();
  return s.length <= max ? s : `…${s.slice(s.length - max)}`;
}
