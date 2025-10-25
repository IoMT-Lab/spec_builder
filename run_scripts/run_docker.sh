#!/bin/bash

pushd `dirname "$0"` >/dev/null

docker run --rm -it --network=host -v `pwd`/../Documents:/app/Documents -v `pwd`/../sessions:/app/sessions spec_builder_app:latest

popd >/dev/null