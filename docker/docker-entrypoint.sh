#!/bin/bash

set -e

pushd /app/backend >/dev/null
npm start &
popd >/dev/null

pushd /app/frontend >/dev/null
npm run dev 
popd >/dev/null