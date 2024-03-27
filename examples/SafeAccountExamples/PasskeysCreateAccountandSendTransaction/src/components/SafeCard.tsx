import { useEffect, useState } from "react";
import {
	SafeAccountWebAuth as SafeAccount,
	getFunctionSelector,
	createCallData,
	MetaTransaction,
	DummySignature,
	CandidePaymaster,
	WebauthPublicKey,
} from "abstractionkit";

import { PasskeyLocalStorageFormat } from "../logic/passkeys";
import { signAndSendUserOp } from "../logic/userOp";
import { getItem } from "../logic/storage";
import { JsonRpcProvider } from "ethers";

const jsonRPCProvider = import.meta.env.VITE_JSON_RPC_PROVIDER;
const bundlerUrl = import.meta.env.VITE_BUNDLER_URL;
const paymasterUrl = import.meta.env.VITE_PAYMASTER_URL;
const entrypoint = import.meta.env.VITE_ENTRYPOINT_ADDRESS;
const chainId = import.meta.env.VITE_CHAIN_ID;
const chainName = import.meta.env.VITE_CHAIN_NAME as string;

function SafeCard({ passkey }: { passkey: PasskeyLocalStorageFormat }) {
	const [userOpHash, setUserOpHash] = useState<string>();
	const [deployed, setDeployed] = useState<boolean>(false);
	const [loadingTx, setLoadingTx] = useState<boolean>(false);
	const [error, setError] = useState<string>();
	const [txHash, setTxHash] = useState<string>();

	const accountAddress = getItem("accountAddress") as string;
	const provider = new JsonRpcProvider(import.meta.env.VITE_JSON_RPC_PROVIDER);

	const isDeployed = async () => {
		const safeCode = await provider.getCode(accountAddress);
		setDeployed(safeCode !== "0x");
	};

	const handleDeploySafeClick = async () => {
		setLoadingTx(true);
		// mint an NFT
		const nftContractAddress = "0x9a7af758aE5d7B6aAE84fe4C5Ba67c041dFE5336";
		const mintFunctionSignature = "mint(address)";
		const mintFunctionSelector = getFunctionSelector(mintFunctionSignature);
		const mintTransactionCallData = createCallData(
			mintFunctionSelector,
			["address"],
			[accountAddress],
		);
		const mintTransaction: MetaTransaction = {
			to: nftContractAddress,
			value: 0n,
			data: mintTransactionCallData,
		};

		const webauthPublicKey: WebauthPublicKey = {
			x: BigInt(passkey.pubkeyCoordinates.x),
			y: BigInt(passkey.pubkeyCoordinates.y),
		};

		const safeAccount = SafeAccount.initializeNewAccount([webauthPublicKey]);

		let userOperation = await safeAccount.createUserOperation(
			[mintTransaction],
			jsonRPCProvider,
			bundlerUrl,
			{
				dummySingatures: [DummySignature.webauth],
			},
		);

		let paymaster: CandidePaymaster = new CandidePaymaster(paymasterUrl);
		userOperation = await paymaster.createSponsorPaymasterUserOperation(
			userOperation,
			bundlerUrl,
		);
		setLoadingTx(false);
		try {
			const bundlerResponse = await signAndSendUserOp(
				safeAccount,
				userOperation,
				passkey,
				entrypoint,
				chainId,
			);
			setUserOpHash(bundlerResponse.userOperationHash);
			let userOperationReceiptResult = await bundlerResponse.included();
			if (userOperationReceiptResult.success) {
				setTxHash(userOperationReceiptResult.receipt.transactionHash);
				console.log(
					"Two Nfts were minted. The transaction hash is : " +
						userOperationReceiptResult.receipt.transactionHash,
				);
			} else {
				setError("Useroperation execution failed");
			}
		} catch (error) {
			if (error instanceof Error) {
				setError(error.message);
			} else {
				setError("Unknown error");
			}
		}
	};

	const readyToDeploy = !userOpHash && !deployed;

	useEffect(() => {
		if (accountAddress) {
			async function isAccountDeployed() {
				await isDeployed();
			}
			isAccountDeployed();
		}
	}, [deployed, accountAddress]);

	return (
		<div className="card">
			{userOpHash && (
				<p>
					Your Safe is being deployed. Track the user operation on{" "}
					<a
						target="_blank"
						href={`https://jiffyscan.xyz/userOpHash/${userOpHash}?network=${chainName.toLowerCase()}`}
					>
						jiffyscan explorer
					</a>
				</p>
			)}
			{(deployed || txHash) && (
				<p>
					You deployed a Safe Account and collected an NFT, secured with your
					Device Passkeys
					<br />
					<br />
					View more on{" "}
					{txHash ? (
						<a
							target="_blank"
							href={`https://${chainName}.etherscan.io/tx/${txHash}`}
						>
							etherscan
						</a>
					) : (
						<a
							target="_blank"
							href={`https://${chainName}.etherscan.io/address/${accountAddress}`}
						>
							etherscan
						</a>
					)}
				</p>
			)}
			{loadingTx ? (
				<p>"Preparing transaction.."</p>
			) : (
				readyToDeploy && (
					<button onClick={handleDeploySafeClick}>Setup up & Mint</button>
				)
			)}{" "}
			{error && (
				<div className="card">
					<p>Error: {error}</p>
				</div>
			)}
		</div>
	);
}

export { SafeCard };
