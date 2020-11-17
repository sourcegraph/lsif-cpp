# C/C++ LSIF indexer ![](https://img.shields.io/badge/status-beta-orange?style=flat)

Visit https://lsif.dev/ to learn about LSIF.

## Installation

Required tools:

- [Node.js](https://nodejs.org/en/)
- [Yarn](https://yarnpkg.com/lang/en/)
- [make](https://www.gnu.org/software/make/)
- A C++ compiler with LLVM dev headers (versions 3 through 9 are supported)

**macOS**

```
brew install git node llvm@8
npm i -g yarn
```

**Debian/Ubuntu**

1. `apt install clang libclang-dev llvm`
1. Install Node.js (if it's not already installed): `apt install nodejs npm`
1. [Install Yarn](https://classic.yarnpkg.com/en/docs/install/#debian-stable)

### Build the C++ compiler plugin and the LSIF conversion tool:

```
git clone https://github.com/sourcegraph/lsif-cpp
cd lsif-cpp
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

> - `ABSROOTDIR`: the absolute path to your project directory (the script will `cd` here before running the compilation command)
> - `ABSOUTDIR`: the absolute path to the directory where the generated CSV files will be written

Convert those CSV files into LSIF:

```
node \
  <path to lsif-cpp>/out/main.js \
  --csvFileGlob="examples/cross-app/output/*.csv" \
  --root=examples/cross-app/root \
  --out examples/cross-app/root/dump.lsif
```

> - `--csvFileGlob`: the wildcard pattern that matches all CSV files written to `ABSOUTDIR` by the `generate-csv` command
> - `--root`: the path to `ABSROOTDIR`
> - `--out`: the path where the LSIF dump will be written
