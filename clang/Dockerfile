FROM ubuntu:14.04.3@sha256:0ca448cb174259ddb2ae6e213ebebe7590862d522fe38971e1175faedf0b6823

RUN DEBIAN_FRONTEND=noninteractive apt-get -q update && apt-get -q -y install llvm-3.8 libclang-3.8-dev clang-3.8 build-essential

# Aliases
RUN update-alternatives --force --install /usr/local/bin/llvm-config llvm-config /usr/bin/llvm-config-3.8 0
RUN update-alternatives --force --install /usr/local/bin/clang++ clang++ /usr/bin/clang++-3.8 0
RUN update-alternatives --force --install /usr/local/bin/clang clang /usr/bin/clang-3.8 0

COPY . /clang

WORKDIR /clang
RUN make
