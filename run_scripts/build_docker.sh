#!/bin/bash

pushd `dirname "$0"` >/dev/null

docker build -f ../docker/Dockerfile -t spec_builder_app:latest ..

popd >/dev/null