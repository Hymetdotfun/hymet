# Read-only DAMM V2 account schema

Source: https://github.com/MeteoraAg/damm-v2-sdk/blob/a8fadfac18f63d1e3a5af7170d4b9bdc781bdc15/src/idl/cp_amm.json

The JSON retains only Pool and its transitive account types, unchanged from the official IDL (metadata version 0.2.5). No transaction instructions or position/fee claim implementation are included. BorshAccountsCoder checks the discriminator; the reader additionally checks exact account size, version, mint pair, owner, executable program and the DBC SDK-derived destination PDA. Future unsupported layouts fail closed to an unverified destination. This schema remains the independent migration-account check. The separate position/claim integration now uses official cp-amm-sdk 1.5.1.

