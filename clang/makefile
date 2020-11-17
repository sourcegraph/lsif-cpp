UNAME_S := $(shell uname -s)

LLVM_CONFIG ?= llvm-config
LLVM_LDFLAGS := $(shell ${LLVM_CONFIG} --ldflags)
ifeq ($(LLVM_LDFLAGS),)
$(error Could not run $(LLVM_CONFIG).  Please make sure it is available on your PATH \
or specify the absolute path of the llvm-config executable in the LLVM_CONFIG environment variable)
endif
CXXFLAGS :=  -std=c++11 $(shell ${LLVM_CONFIG} --cxxflags) -fPIC -O2 -Wall -Wno-strict-aliasing $(if $(DEBUG),-O0 -g)

ifeq ($(UNAME_S),Linux)
    LDFLAGS := -fPIC -g -Wl,-rpath -Wl,'$$ORIGIN' $(LLVM_LDFLAGS) -shared
endif
ifeq ($(UNAME_S),Darwin)
    LDFLAGS := -fPIC -g -Wl,-rpath -Wl,'$$ORIGIN' $(LLVM_LDFLAGS) -shared -undefined dynamic_lookup
endif

build: libclang-index-plugin.so

%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c $^ -o $@

libclang-index-plugin.so: dxr-index.o sha1.o
	$(CXX) $(LDFLAGS) $^ -o $@

check: build
	which clang
	which clang++

clean:
	$(RM) *.o libclang-index-plugin.so

.PHONY: build check clean
