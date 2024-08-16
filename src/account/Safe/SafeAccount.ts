import {
	Wallet,
	AbiCoder,
	TypedDataEncoder,
	keccak256,
	solidityPacked,
	solidityPackedKeccak256,
    ethers,
} from "ethers";
import { SmartAccount } from "../SmartAccount";
import { 
    BaseUserOperationDummyValues,
    ZeroAddress,
    Safe_L2_V1_4_1,
    ENTRYPOINT_V6, ENTRYPOINT_V7
} from "../../constants";
import {
	MetaTransaction,
	Operation,
	StateOverrideSet,
    BaseUserOperation,
	UserOperationV6,
	UserOperationV7,
} from "../../types";
import {
	createCallData,
	getFunctionSelector,
	fetchAccountNonce,
	fetchGasPrice,
    sendEthCallRequest,
    sendEthGetCodeRequest,
} from "../../utils";

import {
    CreateBaseUserOperationOverrides,
	Signer,
	SafeUserOperationTypedDataDomain,
	SafeUserOperationV6TypedDataValues,
	SafeUserOperationV7TypedDataValues,
	SignerSignaturePair,
	WebauthSignatureData,
	SafeModuleExecutorFunctionSelector,
    EOADummySignature,
    WebAuthnSignatureOverrides,
    BaseInitOverrides
} from "./types";
import { decodeMultiSendCallData, encodeMultiSendCallData } from "./multisend";
import { AbstractionKitError } from "src/errors";
import { Bundler } from "src/Bundler";
import { SendUseroperationResponse } from "../SendUseroperationResponse";
import { SafeAccountFactory } from "src/factory/SafeAccountFactory";


export class SafeAccount extends SmartAccount {
    static readonly DEFAULT_SAFE_SINGLETON = Safe_L2_V1_4_1;

    static readonly DEFAULT_WEB_AUTHN_SHARED_SIGNER: string =
        "0xfD90FAd33ee8b58f32c00aceEad1358e4AFC23f9"
    static readonly DEFAULT_WEB_AUTHN_SIGNER_SINGLETON: string =
        "0x270D7E4a57E6322f336261f3EaE2BADe72E68d72"
	static readonly DEFAULT_WEB_AUTHN_SIGNER_FACTORY: string =
        "0xF7488fFbe67327ac9f37D5F722d83Fc900852Fbf"
	static readonly DEFAULT_WEB_AUTHN_FCLP256_VERIFIER: string =
        "0x445a0683e494ea0c5AF3E83c5159fBE47Cf9e765";
    static readonly DEFAULT_WEB_AUTHN_PRECOMPILE: string =
        "0x0000000000000000000000000000000000000000"; //zero address means no precompile
    static readonly DEFAULT_WEB_AUTHN_SIGNER_PROXY_CREATION_CODE =
        "0x61010060405234801561001157600080fd5b506040516101ee3803806101ee83398101604081905261003091610058565b6001600160a01b0390931660805260a09190915260c0526001600160b01b031660e0526100bc565b6000806000806080858703121561006e57600080fd5b84516001600160a01b038116811461008557600080fd5b60208601516040870151606088015192965090945092506001600160b01b03811681146100b157600080fd5b939692955090935050565b60805160a05160c05160e05160ff6100ef60003960006008015260006031015260006059015260006080015260ff6000f3fe608060408190527f00000000000000000000000000000000000000000000000000000000000000003660b681018290527f000000000000000000000000000000000000000000000000000000000000000060a082018190527f00000000000000000000000000000000000000000000000000000000000000008285018190527f00000000000000000000000000000000000000000000000000000000000000009490939192600082376000806056360183885af490503d6000803e8060c3573d6000fd5b503d6000f3fea2646970667358221220ddd9bb059ba7a6497d560ca97aadf4dbf0476f578378554a50d41c6bb654beae64736f6c63430008180033"
    
    static readonly DEFAULT_MULTISEND_CONTRACT_ADDRESS =
		"0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";

	static readonly initializerFunctionSelector: string = "0xb63e800d";
	static readonly initializerFunctionInputAbi: string[] = [
		"address[]",
		"uint256",
		"address",
		"bytes",
		"address",
		"address",
		"uint256",
		"address",
	];

	static readonly DEFAULT_EXECUTOR_FUCNTION_SELECTOR =
		SafeModuleExecutorFunctionSelector.executeUserOpWithErrorString;
	static readonly executorFunctionInputAbi: string[] = [
		"address", //to
		"uint256", //value
		"bytes", //data
		"uint8", //operation
	];

	
    protected isInitWebAuthn: boolean;
	protected x: bigint | null = null;
	protected y: bigint | null = null;


	readonly entrypointAddress: string;
	readonly safe4337ModuleAddress: string;
	protected factoryAddress: string | null;
	protected factoryData: string | null;

	constructor(
		accountAddress: string,
		safe4337ModuleAddress: string,
		entrypointAddress: string,
	) {
		super(accountAddress);
		this.entrypointAddress = entrypointAddress;
		this.safe4337ModuleAddress = safe4337ModuleAddress;
		this.factoryAddress = null;
		this.factoryData = null;

		this.isInitWebAuthn = false
	}

	public static createProxyAddress(
		initializerCallData: string,
		c2Nonce: bigint,
		safeFactoryAddress: string = SafeAccountFactory.DEFAULT_FACTORY_ADDRESS,
		singletonInitHash: string = this.DEFAULT_SAFE_SINGLETON.singletonInitHash,
	): string {
		if (c2Nonce < 0n) {
			throw RangeError("c2Nonce can't be negative");
		}

		const salt = keccak256(
			solidityPacked(
				["bytes32", "uint256"],
				[keccak256(initializerCallData), c2Nonce],
			),
		);

		const proxyAdd = solidityPackedKeccak256(
			["bytes1", "address", "bytes32", "bytes32"],
			["0xff", safeFactoryAddress, salt, singletonInitHash],
		).slice(-40);

		return "0x" + proxyAdd;
	}

	/**
	 * encode calldata for a single MetaTransaction to be executed by Safe account
	 */
	public static createAccountCallDataSingleTransaction(
		metaTransaction: MetaTransaction,
        safeModuleExecutorFunctionSelector: SafeModuleExecutorFunctionSelector =
            SafeAccount.DEFAULT_EXECUTOR_FUCNTION_SELECTOR,
	): string {
		const value = metaTransaction.value ?? 0;
		const data = metaTransaction.data ?? "0x";
		const operation = metaTransaction.operation ?? Operation.Call;
		const executorFunctionCallData = SafeAccount.createAccountCallData(
			metaTransaction.to,
			value,
			data,
			operation,
            safeModuleExecutorFunctionSelector
		);
		return executorFunctionCallData;
	}

	/**
	 * encode calldata for a list of MetaTransactions to be executed by Safe account
	 */
	public static createAccountCallDataBatchTransactions(
		metaTransactions: MetaTransaction[],
        safeModuleExecutorFunctionSelector: SafeModuleExecutorFunctionSelector =
            SafeAccount.DEFAULT_EXECUTOR_FUCNTION_SELECTOR,
		multisendContractAddress: string =
            SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
	): string {
		if (metaTransactions.length < 1) {
			throw RangeError("There should be at least one metaTransaction");
		}

		const multiData = encodeMultiSendCallData(metaTransactions);

		const mutisendSelector = "0x8d80ff0a";
		const multiSendCallData = createCallData(
			mutisendSelector,
			["bytes"],
			[multiData],
		);

		const executorFunctionCallData = SafeAccount.createAccountCallData(
			multisendContractAddress,
			0n,
			multiSendCallData,
			Operation.Delegate,
            safeModuleExecutorFunctionSelector
		);

		return executorFunctionCallData;
	}

	/**
	 * encode calldata to be executed by Safe account
	 */
	public static createAccountCallData(
		to: string,
		value: bigint,
		data: string,
		operation: Operation,
		safeModuleExecutorFunctionSelector: SafeModuleExecutorFunctionSelector =
            SafeAccount.DEFAULT_EXECUTOR_FUCNTION_SELECTOR,
	): string {
		const executorFunctionInputParameters = [to, value, data, operation];
		const callData = createCallData(
			safeModuleExecutorFunctionSelector,
			SafeAccount.executorFunctionInputAbi,
			executorFunctionInputParameters,
		);
		return callData;
	}

	/**
	 * decode calldata to a Metatransaction
	 * @returns MetaTransaction, SafeModuleExecutorFunctionSelector
	 */
	public static decodeAccountCallData(
		callData: string,
	): [MetaTransaction, SafeModuleExecutorFunctionSelector] {

        let safeModuleExecutorFunctionSelector:SafeModuleExecutorFunctionSelector | null = null;
		if (callData.startsWith(
				SafeModuleExecutorFunctionSelector.executeUserOpWithErrorString)
        ){
            safeModuleExecutorFunctionSelector =
                SafeModuleExecutorFunctionSelector.executeUserOpWithErrorString
        }
        else if(callData.startsWith(SafeModuleExecutorFunctionSelector.executeUserOp)){
            safeModuleExecutorFunctionSelector =
                SafeModuleExecutorFunctionSelector.executeUserOp
        } 
        if(safeModuleExecutorFunctionSelector != null){
			const abiCoder = AbiCoder.defaultAbiCoder();
			const params = "0x" + callData.slice(10);
			const decodedParams = abiCoder.decode(
				[
					"address", //to
					"uint256", //value
					"bytes", //data
					"uint8", //operation"
				],
				params,
			);
            let accountCallDataString;
            if (typeof decodedParams[2] !== "string") {
                accountCallDataString = new TextDecoder().decode(decodedParams[2]);
            } else {
                accountCallDataString = decodedParams[2];
            }

			return [
                {
                    to:decodedParams[0] as string,
				    value:BigInt(decodedParams[1] as string),
				    data: accountCallDataString,
				    operation: Number(decodedParams[3]),
                },
                safeModuleExecutorFunctionSelector
			];
		} else {
			throw new AbstractionKitError(
				"BAD_DATA",
				"Invalid calldata, should start with " +
					SafeModuleExecutorFunctionSelector.executeUserOpWithErrorString +
					" or " +
					SafeModuleExecutorFunctionSelector.executeUserOp,
				{
					context: {
						callData: callData,
					},
				},
			);
		}
	}
	
	/**
	 * adds a token approve call to the call data for a token paymaster
	 * @returns callData
	 */
	public static prependTokenPaymasterApproveToCallDataStatic(
		callData: string,
		tokenAddress: string,
		paymasterAddress: string,
		approveAmount: bigint,
		multisendContractAddress: string =
            SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
	): string {
        const [metaTransaction, safeModuleExecutorFunctionSelector] =
			SafeAccount.decodeAccountCallData(callData);
		
		const approveFunctionSignature = "approve(address,uint256)";
		const approveFunctionSelector = getFunctionSelector(
			approveFunctionSignature,
		);
		const approveCallData = createCallData(
			approveFunctionSelector,
			["address", "uint256"],
			[paymasterAddress, approveAmount],
		);
		const approveMetatransaction: MetaTransaction = {
			to: tokenAddress,
			value: 0n,
			data: approveCallData,
			operation: Operation.Call,
		};
		const encodedApproveMetatransaction = encodeMultiSendCallData([
			approveMetatransaction,
		]);

		let multiSendCallDataParams = "";
		const mutisendSelector = "0x8d80ff0a";
		if (metaTransaction.data.startsWith(mutisendSelector)) {
			//multisend
			const decodedCalldata = decodeMultiSendCallData(metaTransaction.data);
			multiSendCallDataParams =
				decodedCalldata + encodedApproveMetatransaction.slice(2);
		} else {
            const encodedCallDataMetaTransaction = encodeMultiSendCallData([
				metaTransaction,
			]);
			multiSendCallDataParams =
				encodedCallDataMetaTransaction + encodedApproveMetatransaction.slice(2);
		}
		const multiSendCallData = createCallData(
			mutisendSelector,
			["bytes"],
			[multiSendCallDataParams],
		);

		const executorFunctionCallData = SafeAccount.createAccountCallData(
			multisendContractAddress,
			0n,
			multiSendCallData,
			Operation.Delegate,
            safeModuleExecutorFunctionSelector
		);

		return executorFunctionCallData;
	}
	
	/**
	 * formate a list of eip712 signatures to a useroperation signature
	 * @param signersAddresses - signers public addresses
	 * @param signatures - list of eip712 signatures
	 * @param validAfter - timestamp the signature will be valid after
	 * @param validUntil - timestamp the signature will be valid until
	 * @returns signature
	 */
	public static formatEip712SignaturesToUseroperationSignature(
		signersAddresses: string[],
		signatures: string[],
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
	): string {
		if (signersAddresses.length != signatures.length) {
			throw RangeError(
				"signersAddresses and signatures arrays should be the same length",
			);
		}
		const signersSignatures: Map<string, string> = new Map();

		signersAddresses.forEach((signer, index) => {
			signersSignatures.set(signer.toLocaleLowerCase(), signatures[index]);
		});
		const sortedSignersSignatures = new Map(
			Array.from(signersSignatures).sort(),
		);
		const formatedSignature =
			"0x" +
			Array.from(sortedSignersSignatures.values()).reduce(
				(accumulator, currentValue) => accumulator + currentValue.slice(2),
				"",
			);

		return SafeAccount.formatEip712SingleSignatureToUseroperationSignature(
			formatedSignature,
			validAfter,
			validUntil,
		);
	}

    protected static getUserOperationEip712Hash(
		useroperation: UserOperationV6 | UserOperationV7,
		chainId:bigint,
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
		entrypointAddress: string,
        safe4337ModuleAddress: string,
    ): string{
        if('initCode' in useroperation){ 
            return SafeAccount.getUserOperationEip712Hash_V6(
                useroperation,
                chainId,
                validAfter,
                validUntil,
                entrypointAddress,
                safe4337ModuleAddress
            );
       }else{
            return SafeAccount.getUserOperationEip712Hash_V7(
                useroperation,
                chainId,
                validAfter,
                validUntil,
                entrypointAddress,
                safe4337ModuleAddress
            );
       }
    }


	public static getUserOperationEip712Hash_V6(
		useroperation: UserOperationV6,
		chainId:bigint,
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
		entrypointAddress: string = ENTRYPOINT_V6,
        safe4337ModuleAddress: string = "0xa581c4A4DB7175302464fF3C06380BC3270b4037",
    ): string{
		const SafeUserOperation: SafeUserOperationV6TypedDataValues = {
			safe: useroperation.sender,
			nonce: useroperation.nonce,
			initCode: useroperation.initCode,
			callData: useroperation.callData,
			callGasLimit: useroperation.callGasLimit,
			verificationGasLimit: useroperation.verificationGasLimit,
			preVerificationGas: useroperation.preVerificationGas,
			maxFeePerGas: useroperation.maxFeePerGas,
			maxPriorityFeePerGas: useroperation.maxPriorityFeePerGas,
			paymasterAndData: useroperation.paymasterAndData,
			validAfter: validAfter,
			validUntil: validUntil,
			entryPoint: entrypointAddress,
		};

        const EIP712_SAFE_OPERATION_V6_TYPE = {
            SafeOp: [
                { type: "address", name: "safe" },
                { type: "uint256", name: "nonce" },
                { type: "bytes", name: "initCode" },
                { type: "bytes", name: "callData" },
                { type: "uint256", name: "callGasLimit" },
                { type: "uint256", name: "verificationGasLimit" },
                { type: "uint256", name: "preVerificationGas" },
                { type: "uint256", name: "maxFeePerGas" },
                { type: "uint256", name: "maxPriorityFeePerGas" },
                { type: "bytes", name: "paymasterAndData" },
                { type: "uint48", name: "validAfter" },
                { type: "uint48", name: "validUntil" },
                { type: "address", name: "entryPoint" },
            ],
        };

		const domain: SafeUserOperationTypedDataDomain = {
			chainId,
			verifyingContract: safe4337ModuleAddress,
		};

		return TypedDataEncoder.hash(
			domain,
			EIP712_SAFE_OPERATION_V6_TYPE,
			SafeUserOperation,
		)
	}

    public static getUserOperationEip712Hash_V7(
		useroperation: UserOperationV7,
		chainId:bigint,
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
		entrypointAddress: string = ENTRYPOINT_V7,
        safe4337ModuleAddress: string = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226",
    ): string{
        const abiCoder = AbiCoder.defaultAbiCoder();

        let initCode = "0x";
        if(useroperation.factory != null){
            initCode = useroperation.factory;
            if(useroperation.factoryData != null){
                initCode += useroperation.factoryData.slice(2);
            }
        }
        
        let paymasterAndData = "0x";
        if(useroperation.paymaster != null){
            paymasterAndData = useroperation.paymaster;
            if(useroperation.paymasterVerificationGasLimit != null){
                paymasterAndData += 
                    abiCoder.encode(
                        ["uint128"],
                        [
                            useroperation.paymasterVerificationGasLimit
                        ]
                    ).slice(34);
            }
            if(useroperation.paymasterPostOpGasLimit != null){
                paymasterAndData += 
                    abiCoder.encode(
                        ["uint128"],
                        [
                            useroperation.paymasterPostOpGasLimit
                        ]
                    ).slice(34);
            }
            if(useroperation.paymasterData != null){
                paymasterAndData += useroperation.paymasterData.slice(2); 
            }
        }
		const SafeUserOperation: SafeUserOperationV7TypedDataValues = {
			safe: useroperation.sender,
			nonce: useroperation.nonce,
			initCode: initCode, 
			callData: useroperation.callData,
			verificationGasLimit: useroperation.verificationGasLimit,
            callGasLimit: useroperation.callGasLimit,
			preVerificationGas: useroperation.preVerificationGas,
			maxPriorityFeePerGas: useroperation.maxPriorityFeePerGas,
            maxFeePerGas: useroperation.maxFeePerGas,
			paymasterAndData: paymasterAndData,
			validAfter: validAfter,
			validUntil: validUntil,
			entryPoint: entrypointAddress,
		};

        const EIP712_SAFE_OPERATION_V7_TYPE = {
            SafeOp: [
                { type: "address", name: "safe" },
                { type: "uint256", name: "nonce" },
                { type: "bytes", name: "initCode" },
                { type: "bytes", name: "callData" },
                { type: "uint128", name: "verificationGasLimit" },
                { type: "uint128", name: "callGasLimit" },
                { type: "uint256", name: "preVerificationGas" },
                { type: "uint128", name: "maxPriorityFeePerGas" },
                { type: "uint128", name: "maxFeePerGas" },
                { type: "bytes", name: "paymasterAndData" },
                { type: "uint48", name: "validAfter" },
                { type: "uint48", name: "validUntil" },
                { type: "address", name: "entryPoint" },
            ],
        };

		const domain: SafeUserOperationTypedDataDomain = {
			chainId,
			verifyingContract: safe4337ModuleAddress,
		};

		return TypedDataEncoder.hash(
			domain,
			EIP712_SAFE_OPERATION_V7_TYPE,
			SafeUserOperation,
		)
	}


	/**
	 * formate an eip712 signature to a useroperation signature
	 * @param signature - an eip712 signature
	 * @param validAfter - timestamp the signature will be valid after
	 * @param validUntil - timestamp the signature will be valid until
	 * @returns signature
	 */
	public static formatEip712SingleSignatureToUseroperationSignature(
		signature: string,
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
	): string {
		if (validAfter < 0n) {
			throw RangeError("validAfter can't be negative");
		}
		if (validUntil < 0n) {
			throw RangeError("validUntil can't be negative");
		}

		return solidityPacked(
			["uint48", "uint48", "bytes"],
			[validAfter, validUntil, signature],
		);
	}

	/**
	 * sends a useroperation to a bundler rpc
	 * @param userOperation - useroperation to send
	 * @param bundlerRpc - bundler rpc to send useroperation
	 * @returns promise with SendUseroperationResponse
	 */
	public async sendUserOperation(
		userOperation: UserOperationV6 | UserOperationV7,
		bundlerRpc: string,
	): Promise<SendUseroperationResponse> {
		const bundler = new Bundler(bundlerRpc);
		const sendUserOperationRes = await bundler.sendUserOperation(
			userOperation,
			this.entrypointAddress,
		);

		return new SendUseroperationResponse(
			sendUserOperationRes,
			bundler,
			this.entrypointAddress,
		);
	}

	/**
	 * calculate account address and initcode from owners
	 * @param owners - list of account owners addresses
	 * @param overrides - override values to change the initialization default values
	 * @returns account address and initcode
	 */
	protected static createAccountAddressAndFactoryAddressAndData(
		owners: Signer[],
		overrides: BaseInitOverrides,
        safe4337ModuleAddress: string,
        safeModuleSetupddress: string,
	): [string, string, string] {
		if (owners.length < 1) {
			throw RangeError("There should be at least one owner");
		}
		const initializerCallData = SafeAccount.createInitializerCallData(
			owners,
			overrides.threshold??1,
            safe4337ModuleAddress,
            safeModuleSetupddress,
            overrides.multisendContractAddress ??
                SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
	    	overrides.webAuthnSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_SHARED_SIGNER,
            overrides.eip7212WebAuthPrecompileVerifierForSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE,
            overrides.eip7212WebAuthContractVerifierForSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER, 
		);

        let	safeAccountFactory;
        if(overrides.safeAccountFactoryAddress != null){
            safeAccountFactory = new SafeAccountFactory(
                overrides.safeAccountFactoryAddress);
        }else{
            safeAccountFactory = new SafeAccountFactory();
        }

        let safeSingleton = overrides.safeAccountSingleton ??
            SafeAccount.DEFAULT_SAFE_SINGLETON;
		const sender = this.createProxyAddress(
			initializerCallData,
            overrides.c2Nonce ?? 0n,
			safeAccountFactory.address,
			safeSingleton.singletonInitHash,
		);

		const generatorFunctionInputParameters = [
			safeSingleton.singletonAddress,
			initializerCallData,
            overrides.c2Nonce ?? 0n,
		];

		const factoryGeneratorFunctionCallData =
            safeAccountFactory.getFactoryGeneratorFunctionCallData(
			    generatorFunctionInputParameters,
		    );

		return [sender, safeAccountFactory.address, factoryGeneratorFunctionCallData];
	}

	public static createInitializerCallData(
		owners: Signer[],
		threshold: number,
		safe4337ModuleAddress: string,
		safeModuleSetupddress: string,
        multisendContractAddress: string =
            SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
		webAuthnSharedSigner =
            SafeAccount.DEFAULT_WEB_AUTHN_SHARED_SIGNER,
        eip7212WebAuthPrecompileVerifierForSharedSigner:string =
            SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE,
        eip7212WebAuthContractVerifierForSharedSigner:string =
            SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER, 
	): string {
		if (owners.length < 1) {
			throw RangeError("There should be at least one owner");
		}

		if (threshold < 1) {
			throw RangeError("threshold should be at least one");
		}

		if (threshold > owners.length) {
			throw RangeError("threshold can't be larger than number of owners");
		}
		
		const enable4337ModuleCallData = createCallData(
			"0x8d0dc49f", //enableModules
			["address[]"],
			[[safe4337ModuleAddress]],
		);
        let isInitWebAuthn = false;
        let initializerFunctionInputParameters;

        const owners_str: string[] = [];
        for(const owner of owners){
            if(typeof(owner) != "string"){
                isInitWebAuthn = true;
            }else{
                owners_str.push(owner);
            }
        }

        if(isInitWebAuthn){
            const safeModuleSetupCallData: MetaTransaction = {
                to: safeModuleSetupddress,
                value: 0n,
                data: enable4337ModuleCallData,
                operation: Operation.Delegate,
            };
            const txs = [];
            txs.push(safeModuleSetupCallData);
            const modOwners = [];

            let numOfWebAuthOwners = 0
            for(const owner of owners){
                if(typeof(owner) != "string"){
                    if (numOfWebAuthOwners > 0) {
                        throw RangeError(
                            "Only one WebAuthn owner can be set during initialization");
                    }
                    const addWebauthSigner = createCallData(
                        "0x0dd9692f", //configure
                        ["uint256", "uint256", "uint176"],
                        [
                            owner.x,
                            owner.y,
                            (
                                "0x" +
                                eip7212WebAuthPrecompileVerifierForSharedSigner.slice(-4) +
                                eip7212WebAuthContractVerifierForSharedSigner.slice(2)
                            ),
                        ],
                    );

                    const setSignerCallData: MetaTransaction = {
                        to: webAuthnSharedSigner,
                        value: 0n,
                        data: addWebauthSigner,
                        operation: Operation.Delegate,
                    };
                    txs.push(setSignerCallData);
                    modOwners.push(webAuthnSharedSigner);
                    numOfWebAuthOwners++
                }else{
                    modOwners.push(owner);
                }
            }

            const encodedInit = encodeMultiSendCallData(txs);

            const mutisendSelector = "0x8d80ff0a";
            const multiSendCallData = createCallData(
                mutisendSelector,
                ["bytes"],
                [encodedInit],
            );

            initializerFunctionInputParameters = [
                modOwners,
                threshold,
                multisendContractAddress, //to Contract address for optional delegate call during initialization
                multiSendCallData, //Data payload for optional delegate call during initialization
                safe4337ModuleAddress, //fallbackHandler Handler for fallback calls to this contract
                ZeroAddress, //paymentToken (Safe specific, can be ignored)
                0, //payment (Safe specific, can be ignored)
                ZeroAddress, //paymentReceiver (Safe specific, can be ignored)
            ];
        }else{
            initializerFunctionInputParameters = [
                owners_str, //_owners
                threshold, //_threshold
                safeModuleSetupddress, //to Contract address for optional delegate call during initialization
                enable4337ModuleCallData, //Data payload for optional delegate call during initialization
                safe4337ModuleAddress, //fallbackHandler Handler for fallback calls to this contract
                ZeroAddress, //paymentToken (Safe specific, can be ignored)
                0, //payment (Safe specific, can be ignored)
                ZeroAddress, //paymentReceiver (Safe specific, can be ignored)
            ];
        }

		return createCallData(
			SafeAccount.initializerFunctionSelector,
			SafeAccount.initializerFunctionInputAbi,
			initializerFunctionInputParameters,
		);
	}

	/**
	 * create account initcode
	 * @param owners - list of account owners signers
	 * @param overrides - overrides values to change default values
	 * @returns factoryAddress and factoryData
	 */
	protected static createFactoryAddressAndData(
		owners: Signer[],
        overrides: BaseInitOverrides = {},
        safe4337ModuleAddress: string,
        safeModuleSetupddress: string,
    ): [string,string] {
		if (owners.length < 1) {
			throw RangeError("There should be at least one owner");
		}
        const threshold = overrides.threshold??1;
        const c2Nonce = overrides.c2Nonce??0;
		if (threshold < 1) {
			throw RangeError("threshold should be at least one");
		}

		if (threshold > owners.length) {
			throw RangeError("threshold can't be larger than number of owners");
		}

		if (c2Nonce < 0n) {
			throw RangeError("c2Nonce can't be negative");
		}

        const initializerCallData = SafeAccount.createInitializerCallData(
			owners,
			overrides.threshold??1,
            safe4337ModuleAddress,
            safeModuleSetupddress,
            overrides.multisendContractAddress ??
                SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
	    	overrides.webAuthnSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_SHARED_SIGNER,
            overrides.eip7212WebAuthPrecompileVerifierForSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE,
            overrides.eip7212WebAuthContractVerifierForSharedSigner ??
                SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER, 
		);
        
        let	safeAccountFactory;
        if(overrides.safeAccountFactoryAddress != null){
            safeAccountFactory = new SafeAccountFactory(
                overrides.safeAccountFactoryAddress);
        }else{
            safeAccountFactory = new SafeAccountFactory();
        }

        let safeSingleton = overrides.safeAccountSingleton ??
            SafeAccount.DEFAULT_SAFE_SINGLETON;


		const generatorFunctionInputParameters = [
			safeSingleton.singletonAddress,
			initializerCallData,
			c2Nonce,
		];

		const factoryGeneratorFunctionCallData =
			safeAccountFactory.getFactoryGeneratorFunctionCallData(
				generatorFunctionInputParameters,
			);

		return [safeAccountFactory.address, factoryGeneratorFunctionCallData];
	}

	/**
	 * a non static wrapper function for  prependTokenPaymasterApproveToCallDataStatic
	 * which adds a token approve call to the call data for a token paymaster
	 * @returns callData
	 */
	public prependTokenPaymasterApproveToCallData(
		callData: string,
		tokenAddress: string,
		paymasterAddress: string,
		approveAmount: bigint,
		multisendContractAddress: string =
            SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS,
	): string {
		return SafeAccount.prependTokenPaymasterApproveToCallDataStatic(
			callData,
			tokenAddress,
			paymasterAddress,
			approveAmount,
			multisendContractAddress,
		);
	}

	/**
	 * estimate gas limits for a useroperation
	 * @param userOperation - useroperation to estimate gas for
	 * @param bundlerRpc - bundler rpc for gas estimation
	 * @param stateOverrideSet - state override values to set during gs estimation
	 * @param dummySignatures - list of dummy signatures
	 * @returns promise with [preVerificationGas, verificationGasLimit, callGasLimit]
	 */
	public async estimateUserOperationGas(
		userOperation: UserOperationV6 | UserOperationV7,
		bundlerRpc: string,
		stateOverrideSet?: StateOverrideSet,
		dummySignatures?: SignerSignaturePair[],
	): Promise<[bigint, bigint, bigint]> {
        if(dummySignatures != null){
            if(dummySignatures.length < 1){
                throw RangeError("Number of dummySignatures can't be less than 1");
            }

            userOperation.signature =
                SafeAccount.formatSignaturesToUseroperationSignature(
                    dummySignatures,
                    0xffffffffffffn,
                    0xffffffffffffn,
                );
        }else if(userOperation.signature.length < 3){
            userOperation.signature =
                SafeAccount.formatSignaturesToUseroperationSignature(
                    [EOADummySignature],
                    0xffffffffffffn,
                    0xffffffffffffn,
                );
        }
		const bundler = new Bundler(bundlerRpc);

        const inputMaxFeePerGas = userOperation.maxFeePerGas;
        const inputMaxPriorityFeePerGas = userOperation.maxPriorityFeePerGas;
        userOperation.maxFeePerGas = 0n;
        userOperation.maxPriorityFeePerGas = 0n;
		const estimation = await bundler.estimateUserOperationGas(
			userOperation,
			this.entrypointAddress,
			stateOverrideSet,
		);
        userOperation.maxFeePerGas = inputMaxFeePerGas;
        userOperation.maxPriorityFeePerGas = inputMaxPriorityFeePerGas;

		const preVerificationGas = BigInt(estimation.preVerificationGas);

		let verificationGasLimit:bigint;
        if(dummySignatures != null){
		    verificationGasLimit =
                BigInt(estimation.verificationGasLimit) +
                (BigInt(dummySignatures.length) * 55_000n);
        }else{
		    verificationGasLimit =BigInt(estimation.verificationGasLimit);
        }

		const callGasLimit = BigInt(estimation.callGasLimit);

        return [preVerificationGas, verificationGasLimit, callGasLimit];
	}

	/**
	 * createUserOperation will determine the nonce, fetch the gas prices,
	 * estimate gas limits and return a useroperation to be signed.
	 * you can override all these values using the overrides parameter.
	 * @param transactions - metatransaction list to be encoded
	 * @param providerRpc - node rpc to fetch account nonce and gas prices
	 * @param bundlerRpc - bundler rpc for gas estimation
	 * @param overrides - overrides values to change default values
	 * @returns promise with useroperation
	 */
	protected async createBaseUserOperationAndFactoryAddressAndFactoryData(
		transactions: MetaTransaction[],
        isV06:boolean,
		providerRpc?: string,
		bundlerRpc?: string,
		overrides: CreateBaseUserOperationOverrides = {},
    ): Promise<[BaseUserOperation, string | null, string | null]> {
		if (transactions.length < 1) {
			throw RangeError("There should be at least one transaction");
		}
        const webAuthnSharedSigner =
            overrides.webAuthnSharedSigner??SafeAccount.DEFAULT_WEB_AUTHN_SHARED_SIGNER;
        const safeModuleExecutorFunctionSelector =
            overrides.safeModuleExecutorFunctionSelector??SafeAccount.DEFAULT_EXECUTOR_FUCNTION_SELECTOR;
        const multisendContractAddress =
            overrides.multisendContractAddress??SafeAccount.DEFAULT_MULTISEND_CONTRACT_ADDRESS;

		let nonce = 0n as bigint;

		if (overrides.nonce == null) {
			if (providerRpc != null) {
				nonce = await fetchAccountNonce(
					providerRpc,
					this.entrypointAddress,
					this.accountAddress,
				);
			} else {
				throw new AbstractionKitError(
					"BAD_DATA",
					"providerRpc cant't be null if nonce is not overriden",
				);
			}
		} else {
			nonce = overrides.nonce;
		}

        let factoryAddress:string | null = this.factoryAddress;
		let factoryData:string | null = this.factoryData;

		if (nonce > 0n) {
            factoryAddress = null;
			factoryData = null;
		}else if(this.isInitWebAuthn){
            const eip7212WebAuthPrecompileVerifier =
                overrides.eip7212WebAuthPrecompileVerifier??
                SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE;
            const eip7212WebAuthContractVerifier =
                overrides.eip7212WebAuthContractVerifier??
                SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER;
            const webAuthnSignerFactory =
                overrides.webAuthnSignerFactory??
                SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_FACTORY;
            const webAuthnSignerSingleton =
                overrides.webAuthnSignerSingleton??
                SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_SINGLETON;

            if(this.x == null || this.y == null){
			    throw RangeError(
                    "Invalide account initialization with Webauthn signer." +
                    "Webauthn signer publickey can be null!!"
                );
            }
            
            const createDeterministicWebAuthnVerifierOwner :MetaTransaction =
                SafeAccount.createDeployWebAuthnVerifierMetaTransaction(
                    this.x,
                    this.y,
                    {
                        eip7212WebAuthPrecompileVerifier,
                        eip7212WebAuthContractVerifier,
                        webAuthnSignerFactory,
                    }
                );
            
			const deterministicWebAuthnVerifierAddress =
                SafeAccount.createWebAuthnSignerVerifierAddress(
				    this.x,
				    this.y,
                    eip7212WebAuthPrecompileVerifier,
                    eip7212WebAuthContractVerifier,
                    webAuthnSignerFactory,
                    webAuthnSignerSingleton,
			    )

			const swapSingletonWithDeterministicWebAuthnVerifierOwnerCallData =
                createCallData(
                    "0xe318b52b", //swapOwner
                    [
                        "address", //prevOwner
                        "address", //oldOwner
                        "address"  //newOwner
                    ],
                    [
                        "0x0000000000000000000000000000000000000001", //SENTINEL_OWNERS
                        webAuthnSharedSigner,
                        deterministicWebAuthnVerifierAddress
                    ]
                );

			const swapSingletonWithDeterministicWebAuthnVerifierOwner :MetaTransaction =
            {
				to: this.accountAddress,
				value: 0n,
				data: swapSingletonWithDeterministicWebAuthnVerifierOwnerCallData,
			}

            const clearWebauthSharedSignerCallData = createCallData(
                "0x0dd9692f", //configure
                ["uint256", "uint256", "uint176"],
                [0, 0, 0],
            );

            const clearWebauthSharedSigner: MetaTransaction = {
                to: webAuthnSharedSigner,
                value: 0n,
                data: clearWebauthSharedSignerCallData,
                operation: Operation.Delegate,
            };

			transactions = [
				createDeterministicWebAuthnVerifierOwner,
				swapSingletonWithDeterministicWebAuthnVerifierOwner, 
                clearWebauthSharedSigner
			].concat(transactions)
		}

		if (nonce < 0n) {
			throw RangeError("nonce can't be negative");
		}

		let callData = "0x" as string;
		if (overrides.callData == null) {
			if (transactions.length == 1) {
				callData = SafeAccount.createAccountCallDataSingleTransaction(
					transactions[0],
                    safeModuleExecutorFunctionSelector
				);
			} else {
				callData =
					SafeAccount.createAccountCallDataBatchTransactions(
						transactions,
                        safeModuleExecutorFunctionSelector,
                        multisendContractAddress
					);
			}
		} else {
			callData = overrides.callData;
		}

		let maxFeePerGas = BaseUserOperationDummyValues.maxFeePerGas;
		let maxPriorityFeePerGas = BaseUserOperationDummyValues.maxPriorityFeePerGas;
		if (
			overrides.maxFeePerGas == null ||
			overrides.maxPriorityFeePerGas == null
		) {
			if (providerRpc != null) {
				[maxFeePerGas, maxPriorityFeePerGas] = await fetchGasPrice(providerRpc);
                if(maxFeePerGas == 0n){
                        maxFeePerGas = 1n;
                    }
                    if(maxPriorityFeePerGas == 0n){
                        maxPriorityFeePerGas = 1n;
                    }

                } else {
                    throw new AbstractionKitError(
                        "BAD_DATA",
                        (
                            "providerRpc cant't be null if maxFeePerGas and " +
                            "maxPriorityFeePerGas are not overriden"
                        ),
                    );
                }
		}
		if (
			typeof overrides.maxFeePerGas === "bigint" &&
			overrides.maxFeePerGas < 0n
		) {
			throw RangeError("maxFeePerGas overrid can't be negative");
		}

		if (
			typeof overrides.maxPriorityFeePerGas === "bigint" &&
			overrides.maxPriorityFeePerGas < 0n
		) {
			throw RangeError("maxPriorityFeePerGas overrid can't be negative");
		}

        maxFeePerGas =
			overrides.maxFeePerGas ??
			maxFeePerGas *
				BigInt(
					Math.floor(
						((overrides.maxFeePerGasPercentageMultiplier ?? 0) + 100) / 100,
					),
				);
		maxPriorityFeePerGas =
			overrides.maxPriorityFeePerGas ??
			maxPriorityFeePerGas *
				BigInt(
					Math.floor(
						((overrides.maxPriorityFeePerGasPercentageMultiplier ?? 0) + 100) /
							100,
					),
				);

		const userOperation = {
			...BaseUserOperationDummyValues,
			sender: this.accountAddress,
			nonce: nonce,
			callData: callData,
			maxFeePerGas: maxFeePerGas,
			maxPriorityFeePerGas: maxPriorityFeePerGas,
		};

		let preVerificationGas = BaseUserOperationDummyValues.preVerificationGas;
		let verificationGasLimit = BaseUserOperationDummyValues.verificationGasLimit;
		let callGasLimit = BaseUserOperationDummyValues.callGasLimit;
		
		if (
			overrides.preVerificationGas == null ||
			overrides.verificationGasLimit == null ||
			overrides.callGasLimit == null
		) {
			if (bundlerRpc != null) {
                userOperation.callGasLimit = 0n;
				userOperation.verificationGasLimit = 0n;
				userOperation.preVerificationGas = 0n;
				const inputMaxFeePerGas = userOperation.maxFeePerGas;
				const inputMaxPriorityFeePerGas = userOperation.maxPriorityFeePerGas;
				userOperation.maxFeePerGas = 0n;
				userOperation.maxPriorityFeePerGas = 0n;
                
                let userOperationToEstimate: UserOperationV6 | UserOperationV7;
                if(isV06){
                    let initCode = "0x";
                    if(factoryAddress != null){
                        initCode = factoryAddress;

                        if(factoryData != null){
                            initCode += factoryData.slice(2);
                        }
                    }
                    userOperationToEstimate = {
                        ...userOperation,
                        initCode:initCode,
                        paymasterAndData: "0x"
                    }
                }else{
                    userOperationToEstimate = {
                        ...userOperation,
                        factory: factoryAddress,
                        factoryData: factoryData,
                        paymaster: null,
                        paymasterVerificationGasLimit: null,
                        paymasterPostOpGasLimit: null,
                        paymasterData: null,
                    }
                }
                let dummySignatures;
                if(overrides.dummySignatures != null){ 
                    if(overrides.dummySignatures.length < 1){
                        throw RangeError(
                            "Number of dummySignatures can't be less than 1");
                    }
                    dummySignatures = overrides.dummySignatures;
                }else{
                    dummySignatures = [EOADummySignature];
                }
                userOperation.signature = SafeAccount.formatSignaturesToUseroperationSignature(
                    dummySignatures,
                    0xffffffffffffn,
                    0xffffffffffffn,
                    {webAuthnSharedSigner}
                );

				[preVerificationGas, verificationGasLimit, callGasLimit] =
					await this.estimateUserOperationGas(
						userOperationToEstimate,
						bundlerRpc,
						overrides.state_override_set,
						overrides.dummySignatures,
					);
                verificationGasLimit +=
                    (BigInt(dummySignatures.length) * 55_000n);

                userOperation.maxFeePerGas = inputMaxFeePerGas;
				userOperation.maxPriorityFeePerGas = inputMaxPriorityFeePerGas;
			} else {
				throw new AbstractionKitError(
					"BAD_DATA",
					(
                        "bundlerRpc cant't be null if preVerificationGas," + 
                        "verificationGasLimit and callGasLimit are not overriden"
                    ),
				);
			}
		}
		if (
			typeof overrides.preVerificationGas === "bigint" &&
			overrides.preVerificationGas < 0n
		) {
			throw RangeError("preVerificationGas overrid can't be negative");
		}

		if (
			typeof overrides.verificationGasLimit === "bigint" &&
			overrides.verificationGasLimit < 0n
		) {
			throw RangeError("verificationGasLimit overrid can't be negative");
		}

		if (
			typeof overrides.callGasLimit === "bigint" &&
			overrides.callGasLimit < 0n
		) {
			throw RangeError("callGasLimit overrid can't be negative");
		}

		userOperation.preVerificationGas =
			overrides.preVerificationGas ??
			preVerificationGas *
				BigInt(
					Math.floor(
						((overrides.preVerificationGasPercentageMultiplier ?? 0) + 100) /
							100,
					),
				);

		userOperation.verificationGasLimit =
			overrides.verificationGasLimit ??
			verificationGasLimit *
				BigInt(
					Math.floor(
						((overrides.verificationGasLimitPercentageMultiplier ?? 0) + 100) /
							100,
					),
				);

		userOperation.callGasLimit =
			overrides.callGasLimit ??
			callGasLimit *
				BigInt(
					Math.floor(
						((overrides.callGasLimitPercentageMultiplier ?? 0) + 100) / 100,
					),
				);
		
		return [userOperation, factoryAddress, factoryData];
	}

	/**
	 * create a useroperation signature
	 * @param useroperation - useroperation to sign
	 * @param privateKeys - for the signers
	 * @param chainId - target chain id
	 * @param validAfter - timestamp the signature will be valid after
	 * @param validUntil - timestamp the signature will be valid until
	 * @returns signature
	 */
	public signUserOperation(
		useroperation: UserOperationV6 | UserOperationV7,
		privateKeys: string[],
		chainId: bigint,
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
	): string {
		if (privateKeys.length < 1) {
			throw RangeError("There should be at least one privateKey");
		}
		if (chainId < 0n) {
			throw RangeError("chainId can't be negative");
		}
		if (validAfter < 0n) {
			throw RangeError("validAfter can't be negative");
		}
		if (validUntil < 0n) {
			throw RangeError("validUntil can't be negative");
		}

       const userOperationEip712Hash = SafeAccount.getUserOperationEip712Hash(
            useroperation,
            chainId,
            validAfter,
            validUntil,
            this.entrypointAddress,
            this.safe4337ModuleAddress
        )
               
        const signersAddresses = [];
        const signatures = [];
        for (const privateKey of privateKeys) {
            const wallet = new Wallet(privateKey);
            const SignerSignaturePair = wallet.signingKey.sign(
                userOperationEip712Hash,
            ).serialized;
            signersAddresses.push(wallet.address);
            signatures.push(SignerSignaturePair);
        }

        return SafeAccount.formatEip712SignaturesToUseroperationSignature(
            signersAddresses,
            signatures,
            validAfter,
            validUntil,
        );
	}

	public static createWebAuthnSignerVerifierAddress(
		x: bigint,
		y: bigint,
        eip7212WebAuthPrecompileVerifier:string =
            SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE,
        eip7212WebAuthContractVerifier:string =
            SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER, 
		webAuthnSignerFactory =
            SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_FACTORY,
		webAuthnSignerSingleton =
            SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_SINGLETON
	): string {
        if(
            eip7212WebAuthPrecompileVerifier.length != 42 ||
            eip7212WebAuthPrecompileVerifier.slice(0,38) != ZeroAddress.slice(0,38)
        ){
			throw RangeError(
                "Invalide precompile address. " +
                "It should have the format 0x000000000000000000000000000000000000____");
        }
        const codeHash = keccak256(
			solidityPacked(
                [
                    "bytes",
                    "uint256",
                    "uint256",
                    "uint256",
                    "uint256",
                ],
                [
                    SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_PROXY_CREATION_CODE,
                    webAuthnSignerSingleton,
                    x,
                    y,
                    (
                        "0x" +
                        eip7212WebAuthPrecompileVerifier.slice(-4) +
                        eip7212WebAuthContractVerifier.slice(2)
                    ),
                ]
            ),
		);

		const proxyAdd = solidityPackedKeccak256(
			["bytes1", "address", "bytes32", "bytes32"],
            [
                "0xff",
                webAuthnSignerFactory,
                "0x0000000000000000000000000000000000000000000000000000000000000000",
                codeHash
            ],
		).slice(-40);

		return "0x" + proxyAdd;
	}

	/**
	 * formate a list of eip712 signatures to a useroperation signature
	 * @param signersAddresses - signers public addresses
	 * @param signatures - list of eip712 signatures
	 * @param validAfter - timestamp the signature will be valid after
	 * @param validUntil - timestamp the signature will be valid until
	 * @param webAuthnSignaturesOverrides - overrides values to change default values
	 * @returns signature
	 */
	public static formatSignaturesToUseroperationSignature(
		signatures: SignerSignaturePair[],
		validAfter: bigint = 0n,
		validUntil: bigint = 0n,
        webAuthnSignatureOverrides: WebAuthnSignatureOverrides = {},
    ): string {
        const formatedSignature =  this.buildSignaturesFromSingerSignaturePairs(
            signatures,
            webAuthnSignatureOverrides
        );

		return solidityPacked(
			["uint48", "uint48", "bytes"],
			[validAfter, validUntil, formatedSignature],
		);
	}
	
	public static getLowerCaseAddress(
        signer:Signer,
        webAuthnSignatureOverrides: WebAuthnSignatureOverrides = {},
    ):string{
		if(typeof(signer) == "string"){
			return signer.toLowerCase()
		}else{
            const eip7212WebAuthPrecompileVerifier =
                webAuthnSignatureOverrides.eip7212WebAuthPrecompileVerifier??
                SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE;
            const eip7212WebAuthContractVerifier =
                webAuthnSignatureOverrides.eip7212WebAuthContractVerifier??
                SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER; 
            const webAuthnSignerFactory =
                webAuthnSignatureOverrides.webAuthnSignerFactory??
                SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_FACTORY;
            const webAuthnSignerSingleton =
                webAuthnSignatureOverrides.webAuthnSignerSingleton??
                SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_SINGLETON;

			return SafeAccount.createWebAuthnSignerVerifierAddress(
				signer.x,
				signer.y,
                eip7212WebAuthPrecompileVerifier,
                eip7212WebAuthContractVerifier,
                webAuthnSignerFactory,
                webAuthnSignerSingleton,
			).toLowerCase()
		}
	}

	public static sortSignatures(
        signatures: SignerSignaturePair[],
        webAuthnSignatureOverrides: WebAuthnSignatureOverrides = {},
    ){
		signatures.sort(
            (
                left, right
            ) => SafeAccount.getLowerCaseAddress(
                    left.signer, webAuthnSignatureOverrides
            ).localeCompare(
                SafeAccount.getLowerCaseAddress(
                    right.signer,webAuthnSignatureOverrides)
            )
        )
	}
    
	public static buildSignaturesFromSingerSignaturePairs(
        signatures: SignerSignaturePair[],
        webAuthnSignatureOverrides: WebAuthnSignatureOverrides = {},
    ): string{
		SafeAccount.sortSignatures(signatures, webAuthnSignatureOverrides)
		const start = 65 * signatures.length
		const { segments } = signatures.reduce(
		  ({ segments, offset }, { signer, signature, isContractSignature }) => {
			isContractSignature = isContractSignature || (typeof(signer) != "string")
			if(isContractSignature){
				if(typeof(signer) == "string"){//ECDSAPublicAddress
					return {
						segments: [
                            ...segments,
                            ethers.solidityPacked(
                                ['uint256', 'uint256', 'uint8'],
                                [signer, start + offset, 0]
                            )
                        ],
						offset: offset + 32 + ethers.dataLength(signature),
					}
				}else{//WebauthPublicKey
					if(webAuthnSignatureOverrides.isInit == null){
						throw RangeError(
                            "Must define isInit parameter when using WebAuthn");
					}
					if(webAuthnSignatureOverrides.isInit){
                        const webauthnsharedsigner =
                            webAuthnSignatureOverrides.webAuthnSharedSigner??
                            SafeAccount.DEFAULT_WEB_AUTHN_SHARED_SIGNER
						signer = webauthnsharedsigner 
					}else{
                        const eip7212WebAuthPrecompileVerifier =
                            webAuthnSignatureOverrides.eip7212WebAuthPrecompileVerifier??
                            SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE;
                        const eip7212WebAuthContractVerifier =
                            webAuthnSignatureOverrides.eip7212WebAuthContractVerifier??
                            SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER; 
                        const webAuthnSignerFactory =
                            webAuthnSignatureOverrides.webAuthnSignerFactory??
                            SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_FACTORY;
                        const webAuthnSignerSingleton =
                            webAuthnSignatureOverrides.webAuthnSignerSingleton??
                            SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_SINGLETON;

						signer = SafeAccount.createWebAuthnSignerVerifierAddress(
							signer.x,
							signer.y,
                            eip7212WebAuthPrecompileVerifier,
                            eip7212WebAuthContractVerifier,
                            webAuthnSignerFactory,
                            webAuthnSignerSingleton,
						)
					}
					return {
						segments: [
                            ...segments,
                            ethers.solidityPacked(
                                ['uint256', 'uint256', 'uint8'],
                                [signer, start + offset, 0]
                            )
                        ],
						offset: offset + 32 + ethers.dataLength(signature),
					}
				}
			}else{
				return {
					segments: [
                        ...segments,
                        ethers.solidityPacked(['bytes'], [signature])
                    ],
					offset: 0,
				}
			}
		  },
		  { segments: [] as string[], offset: 0 },
		)
		return ethers.concat([
		  ...segments,
		  ...signatures.map(({ signature }) => ethers.solidityPacked(
              ['uint256', 'bytes'], [ethers.dataLength(signature), signature])),
		])
	  }

	public static createWebAuthnSignature(signatureData:WebauthSignatureData):string{
		return ethers.AbiCoder.defaultAbiCoder().encode(
			['bytes', 'bytes', 'uint256[2]'],
			[
				new Uint8Array(signatureData.authenticatorData),
				signatureData.clientDataFields,
				signatureData.rs,
			],
		)	
	}

    public async createSwapOwnerMetaTransactions(
        nodeRpcUrl: string,
        newOwner: Signer,
        oldOwner: Signer,
        overrides:{
            prevOwner?: string,
            eip7212WebAuthPrecompileVerifier?:string,
            eip7212WebAuthContractVerifier?:string,
            webAuthnSignerFactory?:string,
            webAuthnSignerSingleton?:string,
        } = {}
    ):Promise<MetaTransaction[]>{
        let deployNewOwnerSignerMetaTransaction: MetaTransaction | null = null;
        let newOwnerT:string;
        let oldOwnerT:string;
        
        if(typeof(newOwner) != 'string'){
            newOwnerT = SafeAccount.createWebAuthnSignerVerifierAddress(
                newOwner.x,
                newOwner.y,
                overrides.eip7212WebAuthPrecompileVerifier,
                overrides.eip7212WebAuthContractVerifier,
                overrides.webAuthnSignerFactory,
                overrides.webAuthnSignerSingleton,
            )
            const newOwnerCode = await sendEthGetCodeRequest(
                nodeRpcUrl, newOwnerT, 'latest');
            const newOwnerNotDeployed = newOwnerCode.length < 3;
            if(newOwnerNotDeployed){
                deployNewOwnerSignerMetaTransaction = 
                SafeAccount.createDeployWebAuthnVerifierMetaTransaction(
                    newOwner.x,
                    newOwner.y,
                    {
                        eip7212WebAuthPrecompileVerifier:
                            overrides.eip7212WebAuthPrecompileVerifier,
                        eip7212WebAuthContractVerifier:
                            overrides.eip7212WebAuthContractVerifier,
                        webAuthnSignerFactory:
                            overrides.webAuthnSignerFactory,
                    }
                );
            }
        }else{
            newOwnerT = newOwner;
        }
        if(typeof(oldOwner) != 'string'){
            oldOwnerT = SafeAccount.createWebAuthnSignerVerifierAddress(
                oldOwner.x,
                oldOwner.y,
                overrides.eip7212WebAuthPrecompileVerifier,
                overrides.eip7212WebAuthContractVerifier,
                overrides.webAuthnSignerFactory,
                overrides.webAuthnSignerSingleton,
            )
        }else{
            oldOwnerT = oldOwner;
        }
        
        let prevOwnerT = overrides.prevOwner;
        if(prevOwnerT == null){
            const owners = await this.getOwners(nodeRpcUrl);
            const oldOwnerIndex = owners.indexOf(oldOwnerT);
            if(oldOwnerIndex == -1){
                throw RangeError("oldOwner is not a current owner.");
            }else if(oldOwnerIndex == 0){
                prevOwnerT = "0x0000000000000000000000000000000000000001";
            }else if(oldOwnerIndex > 0){
                prevOwnerT = owners[oldOwnerIndex-1];
            }else{
                throw RangeError("Invalid owner index");
            }
        }
        const swapMetaTransaction =  this.createStandardSwapOwnerMetaTransaction(
            newOwnerT,
            oldOwnerT,
            prevOwnerT
        );
        if(deployNewOwnerSignerMetaTransaction == null){
            return [swapMetaTransaction];
        }else{
            return [deployNewOwnerSignerMetaTransaction, swapMetaTransaction];
        }
    }

    public createStandardSwapOwnerMetaTransaction(
        newOwner: string,
        oldOwner: string,
        prevOwner: string
    ):MetaTransaction{
        const functionSelector = "0xe318b52b"; //swapOwner
        const callData = createCallData(
            functionSelector,
            [
                "address", //prevOwner
                "address", //oldOwner
                "address"  //newOwner
            ],
            [
                prevOwner, //SENTINEL_OWNERS
                newOwner,
                oldOwner
            ]

        );
        return {
            to: this.accountAddress,
            data: callData,
            value: 0n
        }
    }

    public static createDeployWebAuthnVerifierMetaTransaction(
        x: bigint,
        y: bigint,
        overrides:{
            eip7212WebAuthPrecompileVerifier?:string,
            eip7212WebAuthContractVerifier?:string,
            webAuthnSignerFactory?:string,
        } = {}
    ):MetaTransaction{
        const eip7212WebAuthPrecompileVerifier =
            overrides.eip7212WebAuthPrecompileVerifier??
            SafeAccount.DEFAULT_WEB_AUTHN_PRECOMPILE;
        const eip7212WebAuthContractVerifier =
            overrides.eip7212WebAuthContractVerifier ??
            SafeAccount.DEFAULT_WEB_AUTHN_FCLP256_VERIFIER;
        const webAuthnSignerFactory =
            overrides.webAuthnSignerFactory ??
            SafeAccount.DEFAULT_WEB_AUTHN_SIGNER_FACTORY;

        const createDeterministicWebAuthnVerifierOwnerCallData = createCallData(
            "0x0d2f0489", //createSigner
            ["uint256", "uint256", "uint176"],
            [
                x,
                y,
                (
                    "0x" +
                    eip7212WebAuthPrecompileVerifier.slice(-4) +
                    eip7212WebAuthContractVerifier.slice(2)
                )
            ],
        );

        return {
            to: webAuthnSignerFactory,
            value: 0n,
            data: createDeterministicWebAuthnVerifierOwnerCallData,
        }
    }

    
    public async getOwners(nodeRpcUrl: string):Promise<string[]>{
        const functionSignature = "getOwners()";
        const functionSelector = getFunctionSelector(
            functionSignature,
        );
        const callData = createCallData(functionSelector, [], []);

        const ethCallParams ={
            to: this.accountAddress,
            data: callData,
        };
        const recoveryRequestResult = await sendEthCallRequest(
            nodeRpcUrl, ethCallParams, "latest");

        const abiCoder = AbiCoder.defaultAbiCoder();
	    const decodedCalldata = abiCoder.decode(
            ["address[]"], recoveryRequestResult);

        return decodedCalldata[0];
    }
}
