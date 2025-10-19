#!/bin/bash

autossh -f -M 0                     \
        -o "ServerAliveInterval 30" \
        -o "ServerAliveCountMax 30" \
        -L 4040:localhost:4040      \
        -R 4050:localhost:3000      \
        sepehr@37.32.12.202 -N
