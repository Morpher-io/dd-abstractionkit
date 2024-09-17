<!-- PROJECT LOGO -->
<div align="center">
<img src="https://github.com/candidelabs/abstractionkit/assets/7014833/6af73235-3f6b-4cb1-8a57-6b04ba2bf327">
</div>

<div align="center">
  <h3 align="center">Supported by Safe Grants</h3>
</div>

A modified version of the [AbstractionKit](https://github.com/candidelabs/abstractionkit) library to enable support for data-dependent user operations.

## Docs

For full detailed documentation visit the Candide [docs page](https://docs.candide.dev/wallet/abstractionkit/introduction). 

## Installation [todo]

```bash
npm install abstractionkit
```

## Quickstart

The kit is used exaclty as the original one, refer to the original [readme](https://github.com/candidelabs/abstractionkit?tab=readme-ov-file#quickstart) for a quickstart.

The only difference is the management of data dependent user operations. If a contract the user is interacting with requires data, the kit will make use of contract calls and special bundler endpoints to manage that. Make sure that the bundler you're connecting to supports [data-dependency](https://github.com/Morpher-io/dd-voltaire).

### Creating and sending a data-dependent user operation

```typescript
const transaction : MetaTransaction = {
        to: yourDataDepndentContract,
        value: 0n,
        data: transactionCallData,
    }

// bundler will provide gas estimation on data-dependent endpoints
// the userOperation object is also containing the data requirements
const userOperation = await smartAccount.createUserOperation(
        [transaction],
        jsonRpcNodeProvider, // regular ethereum rpc for your chain
        bundlerUrl, // must be a dd-bundler
    )

userOperation.signature = smartAccount.signUserOperation(
        userOperation,
        [ownerPrivateKey],
        chainId,
    )

// correct bundler endpoint will be used according to data-dependecy
const sendUserOperationResponse = await smartAccount.sendUserOperation(
        userOperation, bundlerUrl
    )
```

## npm package [todo]
<a href="https://www.npmjs.com/package/abstractionkit">npm</a>

<!-- LICENSE -->
## License

MIT
