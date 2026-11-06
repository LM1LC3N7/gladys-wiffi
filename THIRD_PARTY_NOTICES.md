# Third-party notices

This integration ports to JavaScript the knowledge of the Wiffi JSON telegrams
held by the following project: how the device sends them (one TCP connection per
telegram, ended by 0x04), their shape (`modultyp`, `vars`, `Systeminfo`) and how
each variable is read. No code is copied, and nothing of it is installed at
runtime; its notice is reproduced as a credit.

The mapping of the units (`gradC`, `grad`, `%`, `mb`, `lux`), the key of each
feature (the variable name) and the silence delay also follow Home Assistant's
wiffi integration (`homeassistant/components/wiffi`, Apache-2.0), read, not copied.

## wiffi

<https://github.com/mampfes/python-wiffi> (version 1.1.2 on PyPI)

```
MIT License

Copyright (c) 2020 Steffen Zimmermann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
