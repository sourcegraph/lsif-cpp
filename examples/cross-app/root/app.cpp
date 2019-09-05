#include "lib.h"
#include <stdio.h>

int main() {
    printf("hello, %s\n", Foo().uppercase("world"));
    printf("hello, %s\n", Bar().uppercase("world"));
}
