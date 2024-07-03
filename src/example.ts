import {
	createCallData,
	getFunctionSelector,
} from "./utils";

import { SafeAccountV0_2_0 } from "./account/Safe/SafeAccountV0_2_0";

const run = async () => {
	const ownerPrivateKey = '0x5496294f10c402840dd3e456bda1277107df0826cbdcd8789f4a960393e6be4e';
	const mintFunctionSignature = 'mint(address)';
	const mintFunctionSelector = getFunctionSelector(mintFunctionSignature);

	const mintTransactionCallData = createCallData(
		mintFunctionSelector,
		["address"],
		['0xE32B71123EfC7cFF89eff38D8080C6300FbA2fAc']
	);
	// console.log(mintTransactionCallData)
	const mintTransaction = {
		to: '0x7d74aAa6a72B327C04fBC032D4ABfe0586d3fB26',
		value: BigInt('2000000000000000'),
		data: mintTransactionCallData,
	}
	const smartAccount = new SafeAccountV0_2_0('0xE32B71123EfC7cFF89eff38D8080C6300FbA2fAc');
	const mintUserOp = await smartAccount.createUserOperation(
		[mintTransaction],
		'https://ethereum-sepolia.blockpi.network/v1/rpc/public',
		'http://localhost:3000/rpc',
	)

	mintUserOp.verificationGasLimit = BigInt(Math.round(Number(mintUserOp.verificationGasLimit) * 1.2));
    mintUserOp.maxFeePerGas = BigInt('90000000000');

    mintUserOp.signature = smartAccount.signUserOperation(
        mintUserOp,
        [ownerPrivateKey],
        11155111n
    )
    
	await smartAccount.sendUserOperation(mintUserOp, 'http://localhost:3000/rpc')

	console.log('User operation sent!');
}

run();
