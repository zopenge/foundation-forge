#pragma once

#include "sample-types.hpp"

namespace fixture {
class ICompressor {
public:
  virtual ~ICompressor() = default;
  virtual int compress(const char* input) = 0;
};
}
