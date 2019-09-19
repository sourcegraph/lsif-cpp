# C/C++ LSIF indexer

This project is at the proof-of-concept stage.

## Language Server Index Format

The purpose of the Language Server Index Format (LSIF) is to define a standard format for language servers or other programming tools to dump their knowledge about a workspace. This dump can later be used to answer language server [LSP](https://microsoft.github.io/language-server-protocol/) requests for the same workspace without running the language server itself. Since much of the information would be invalidated by a change to the workspace, the dumped information typically excludes requests used when mutating a document. So, for example, the result of a code complete request is typically not part of such a dump.

A first draft specification can be found [here](https://github.com/Microsoft/language-server-protocol/blob/master/indexFormat/specification.md).

## Quickstart

Build the `clang` docker container that contains the instrumented compiler and this tool:

```
./build && ./clang/build
```

Compile a C/C++ project and generate intermediate CSV output:

```
env \
  CLEAN=true \
  ABSROOTDIR=$PWD/examples/cross-app/root \
  ABSOUTDIR=$PWD/examples/cross-app/output \
  ./generate-csv "\$CXX -c *.cpp"
```

Convert that CSV into LSIF:

```
node \
  ./out/main.js \
  --csvFileGlob="examples/cross-app/output/*.csv" \
  --root=examples/cross-app/root \
  --out app.lsif
```

Upload the LSIF data to Sourcegraph:

```
env \
  SRC_ENDPOINT=http://localhost:3080 \
  REPOSITORY=127.0.0.1-3434/repos/cross-lib/root \
  COMMIT=$libcommit \
  bash ~/github.com/sourcegraph/sourcegraph/lsif/upload.sh app.lsif
```
