#include "five.h"

#define TABLE_SIZE 100

int x = TABLE_SIZE;

int four(int y) {
  return y;
}

int main() {
  five(x);
  four(x);
  five(six);
}
