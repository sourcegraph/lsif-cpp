# C/C++ LSIF indexer

Visit https://lsif.dev/ to learn about LSIF.

## Prerequisites

- [Node.js](https://nodejs.org/en/) (macOS: `brew install node`)
- [Yarn](https://yarnpkg.com/lang/en/) (macOS: `npm i -g yarn`)
- [make](https://www.gnu.org/software/make/)
- A C++ compiler

## Installation

Build the instrumented compiler and the LSIF conversion tool:

```
./build
```

## Indexing your repository

Compile a C/C++ project with the instrumented compiler to generate intermediate CSV output:

```
env \
  CLEAN=true \
  ABSROOTDIR=$PWD/examples/cross-app/root \
  ABSOUTDIR=$PWD/examples/cross-app/output \
  <path to lsif-cpp>/generate-csv "\$CXX -c *.cpp"
```

Convert those CSV files into LSIF:

```
node \
  <path to lsif-cpp>/out/main.js \
  --csvFileGlob="examples/cross-app/output/*.csv" \
  --root=examples/cross-app/root \
  --out app.lsif
```
